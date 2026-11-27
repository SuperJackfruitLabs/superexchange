import { describe, expect, test } from "bun:test";
import {
  CallUpstreamError,
  DELAYED_EVENT_TIMEOUT_MS,
  RESTART_INTERVAL_MS,
  createCallHomeserver,
  createMembershipCheck,
} from "../src/calls/index.ts";
import { MEMBERSHIP_TIMEOUT_MS } from "../src/calls/hub.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** The error a promise rejects with, which must be a CallUpstreamError. */
async function upstreamError(
  promise: Promise<unknown>,
): Promise<CallUpstreamError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof CallUpstreamError)) {
    throw new Error("expected a CallUpstreamError");
  }
  return error;
}

/** A fetch that records each request and answers with `answer`'s status and JSON. */
function fakeFetch(
  answer: (url: string) => { status: number; json?: unknown } | "throw",
) {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const a = answer(url);
    if (a === "throw") throw new Error(`connect failed for ${url}`);
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), {
      status: a.status,
    });
  };
  const fetch: typeof globalThis.fetch = Object.assign(impl, {
    preconnect: () => {},
  });
  return { fetch, seen };
}

const ACCESS = "openid-access-token-for-tests";
const openid = (overrides: Record<string, unknown> = {}) => ({
  access_token: ACCESS,
  token_type: "Bearer",
  matrix_server_name: "s.example",
  expires_in: 3600,
  ...overrides,
});

const hs = (fetch: typeof globalThis.fetch) =>
  createCallHomeserver({
    homeserverUrl: "https://matrix.s.example/",
    serverName: "s.example",
    fetch,
  });

describe("calls: the homeserver's OpenID check", () => {
  test("asks userinfo with the token, and answers the user it names", async () => {
    const f = fakeFetch(() => ({ status: 200, json: { sub: "@u:s.example" } }));
    expect(await hs(f.fetch).verifyOpenId(openid())).toBe("@u:s.example");
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.url).toBe(
      `https://matrix.s.example/_matrix/federation/v1/openid/userinfo?access_token=${ACCESS}`,
    );
    expect(f.seen[0]?.method).toBe("GET");
    expect(f.seen[0]?.headers.authorization).toBeUndefined();
  });

  test("a token the homeserver refuses names nobody", async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch(() => ({
        status,
        json: { errcode: "M_UNKNOWN_TOKEN" },
      }));
      expect(await hs(f.fetch).verifyOpenId(openid())).toBeNull();
    }
  });

  test("a user on another server names nobody", async () => {
    for (const sub of ["@u:other.example", "u:s.example", "", 7, null]) {
      const f = fakeFetch(() => ({ status: 200, json: { sub } }));
      expect(await hs(f.fetch).verifyOpenId(openid())).toBeNull();
    }
  });

  test("a token for another server, or no token, is never sent anywhere", async () => {
    const f = fakeFetch(() => ({ status: 200, json: { sub: "@u:s.example" } }));
    for (const token of [
      openid({ matrix_server_name: "evil.example" }),
      openid({ matrix_server_name: undefined }),
      openid({ access_token: "" }),
      openid({ access_token: 7 }),
      openid({ access_token: "a b" }),
      "a string",
      null,
      [],
    ]) {
      expect(await hs(f.fetch).verifyOpenId(token)).toBeNull();
    }
    expect(f.seen).toEqual([]);
  });

  test("a homeserver that cannot answer throws, without quoting the token", async () => {
    for (const answer of [{ status: 500 }, "throw" as const]) {
      const f = fakeFetch(() => answer);
      const error = await upstreamError(hs(f.fetch).verifyOpenId(openid()));
      expect(error.service).toBe("homeserver");
      expect(error.message).not.toContain(ACCESS);
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("calls: the tokenless delayed-event action (MSC4140)", () => {
  // tuwunel 2.0.0 takes the delay id as the authority only on the path form
  // (`…/delayed_events/{id}/restart`); the body form (`{"action":…}`) needs an access token
  // and answers 401 M_MISSING_TOKEN without one (seen on staging, 2026-11-26).
  test("restart and send, on the path form, with no access token", async () => {
    const f = fakeFetch(() => ({ status: 200, json: {} }));
    expect(await hs(f.fetch).delayedEvent("syd_a/b", "restart")).toBe("ok");
    expect(await hs(f.fetch).delayedEvent("syd_a/b", "send")).toBe("ok");
    expect(f.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      [
        "POST",
        "https://matrix.s.example/_matrix/client/unstable/org.matrix.msc4140/delayed_events/syd_a%2Fb/restart",
        {},
      ],
      [
        "POST",
        "https://matrix.s.example/_matrix/client/unstable/org.matrix.msc4140/delayed_events/syd_a%2Fb/send",
        {},
      ],
    ]);
    for (const s of f.seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.url).not.toContain("access_token");
    }
  });

  test("a delay the homeserver no longer has is gone", async () => {
    for (const status of [400, 404, 409]) {
      const f = fakeFetch(() => ({ status, json: { errcode: "M_NOT_FOUND" } }));
      expect(await hs(f.fetch).delayedEvent("syd_1", "restart")).toBe("gone");
    }
  });

  test("refused, rate limited, failing or unreachable throws, without quoting the delay id", async () => {
    // 401/403 say the homeserver will not take the call, not that the delay is gone: forgetting
    // the leave there would silently turn off every restart and send.
    for (const answer of [
      { status: 401, json: { errcode: "M_MISSING_TOKEN" } },
      { status: 403 },
      { status: 429 },
      { status: 502 },
      "throw" as const,
    ]) {
      const f = fakeFetch(() => answer);
      const error = await upstreamError(
        hs(f.fetch).delayedEvent("syd_secret", "send"),
      );
      expect(error.message).not.toContain("syd_secret");
    }
  });

  test("a restart that hangs gives up at DELAYED_EVENT_TIMEOUT_MS, before the next is due", async () => {
    const homeserver = createCallHomeserver({
      homeserverUrl: "https://matrix.s.example",
      serverName: "s.example",
      fetch: sequence(["hang"]).fetch,
      // The OpenID check's own, longer timeout is not the action's.
      timeoutMs: 60_000,
    });
    const started = performance.now();
    const error = await upstreamError(
      homeserver.delayedEvent("syd_1", "restart"),
    );
    const waited = performance.now() - started;
    expect(error.message).toContain("delayed event restart unreachable");
    expect(waited).toBeGreaterThanOrEqual(DELAYED_EVENT_TIMEOUT_MS - 50);
    expect(waited).toBeLessThan(RESTART_INTERVAL_MS);
  });
});

/** Answers in turn; `"hang"` never answers, so only the attempt's timeout ends it. */
function sequence(
  answers: Array<{ status: number; json?: unknown } | "hang" | "throw">,
) {
  let n = 0;
  const impl = async (_input: string | URL | Request, init?: RequestInit) => {
    const a = answers[n++] ?? answers.at(-1);
    if (a === "throw") throw new Error("connect failed");
    if (a === "hang" || a === undefined) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    }
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), {
      status: a.status,
    });
  };
  const fetch: typeof globalThis.fetch = Object.assign(impl, {
    preconnect: () => {},
  });
  return { fetch, attempts: () => n };
}

describe("calls: the hub's membership check (C4)", () => {
  const TOKEN = "membership-token-for-tests";
  const hub = (fetch: typeof globalThis.fetch) =>
    createMembershipCheck({
      hubUrl: "https://hub.example/",
      token: TOKEN,
      fetch,
    });
  const quickHub = (fetch: typeof globalThis.fetch) =>
    createMembershipCheck({
      hubUrl: "https://hub.example",
      token: TOKEN,
      fetch,
      timeoutMs: 20,
    });

  test("posts the user and room with the bearer, and reads an allowed answer", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      json: {
        allowed: true,
        agent_user_id: "@agent_x:s.example",
        station_id: "station_1",
      },
    }));
    expect(await hub(f.fetch).check("@u:s.example", "!r:s.example")).toEqual({
      allowed: true,
      agentUserId: "@agent_x:s.example",
      stationId: "station_1",
    });
    expect(
      f.seen.map(({ url, method, body }) => ({ url, method, body })),
    ).toEqual([
      {
        url: "https://hub.example/internal/superdial/membership",
        method: "POST",
        body: { user_id: "@u:s.example", room_id: "!r:s.example" },
      },
    ]);
    expect(f.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.seen[0]?.headers["content-type"]).toBe("application/json");
  });

  test("each refusal carries its reason", async () => {
    for (const reason of [
      "not_member",
      "not_agent_room",
      "harness_mode",
      "calls_disabled",
    ]) {
      const f = fakeFetch(() => ({
        status: 200,
        json: { allowed: false, reason },
      }));
      expect(await hub(f.fetch).check("@u:s.example", "!r:s.example")).toEqual({
        allowed: false,
        reason,
      });
    }
  });

  /**
   * A slow hub is not a refusal. E1 (2026-11-27): the hub took 5 s over its first, cold C4
   * answer, the old 5 s timeout gave up, and the caller's `/v1/token` was a 503. Each attempt now
   * waits 15 s, and one that times out or fails 5xx is tried once more.
   */
  describe("a slow or failing hub is asked twice", () => {
    const ALLOWED = {
      status: 200,
      json: {
        allowed: true,
        agent_user_id: "@agent_x:s.example",
        station_id: "station_1",
      },
    };

    test("each attempt waits 15 s by default", () => {
      expect(MEMBERSHIP_TIMEOUT_MS).toBe(15_000);
    });

    test("an attempt that times out is retried once, and the second answer is the answer", async () => {
      const f = sequence(["hang", ALLOWED]);
      expect(
        (await quickHub(f.fetch).check("@u:s.example", "!r:s.example")).allowed,
      ).toBe(true);
      expect(f.attempts()).toBe(2);
    });

    test("a 5xx is retried once", async () => {
      const f = sequence([{ status: 502 }, ALLOWED]);
      expect(
        (await quickHub(f.fetch).check("@u:s.example", "!r:s.example")).allowed,
      ).toBe(true);
      expect(f.attempts()).toBe(2);
    });

    test("two failed attempts are still a hub error (503 at /v1/token), and there is no third", async () => {
      for (const answers of [
        ["hang", "hang"],
        [{ status: 500 }, { status: 503 }],
        ["hang", { status: 500 }],
      ] as const) {
        const f = sequence([...answers]);
        const error = await upstreamError(
          quickHub(f.fetch).check("@u:s.example", "!r:s.example"),
        );
        expect(error.service).toBe("hub");
        expect(f.attempts()).toBe(2);
      }
    });

    test("a refused token, a 4xx, an unreachable hub or a malformed answer is not retried", async () => {
      for (const answer of [
        { status: 401 },
        { status: 404 },
        { status: 200, json: { allowed: "yes" } },
        "throw" as const,
      ]) {
        const f = sequence([answer, ALLOWED]);
        await upstreamError(
          quickHub(f.fetch).check("@u:s.example", "!r:s.example"),
        );
        expect(f.attempts()).toBe(1);
      }
    });
  });

  test("a hub that refuses the token, fails, is unreachable or answers nonsense is never an answer", async () => {
    for (const answer of [
      { status: 401, json: { error: "unauthorized" } },
      { status: 500 },
      { status: 200, json: { allowed: "yes" } },
      { status: 200, json: { allowed: true } },
      { status: 200, json: { allowed: false } },
      { status: 200, json: { allowed: false, reason: 7 } },
      { status: 200 },
      "throw" as const,
    ]) {
      const f = fakeFetch(() => answer);
      const error = await upstreamError(
        hub(f.fetch).check("@u:s.example", "!r:s.example"),
      );
      expect(error.service).toBe("hub");
      expect(error.message).not.toContain(TOKEN);
    }
  });
});
