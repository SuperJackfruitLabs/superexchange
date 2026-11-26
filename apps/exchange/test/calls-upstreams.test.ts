import { describe, expect, test } from "bun:test";
import {
  CallUpstreamError,
  createCallHomeserver,
  createMembershipCheck,
} from "../src/calls/index.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each request and answers with `answer`'s status and JSON. */
function fakeFetch(
  answer: (url: string) => { status: number; json?: unknown } | "throw",
) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
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
  }) as typeof globalThis.fetch;
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
      const error = await hs(f.fetch)
        .verifyOpenId(openid())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallUpstreamError);
      expect((error as CallUpstreamError).service).toBe("homeserver");
      expect(String(error)).not.toContain(ACCESS);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe("calls: the tokenless delayed-event action (MSC4140)", () => {
  test("restart and send, with no access token", async () => {
    const f = fakeFetch(() => ({ status: 200, json: {} }));
    expect(await hs(f.fetch).delayedEvent("syd_a/b", "restart")).toBe("ok");
    expect(await hs(f.fetch).delayedEvent("syd_a/b", "send")).toBe("ok");
    expect(f.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      [
        "POST",
        "https://matrix.s.example/_matrix/client/unstable/org.matrix.msc4140/delayed_events/syd_a%2Fb",
        { action: "restart" },
      ],
      [
        "POST",
        "https://matrix.s.example/_matrix/client/unstable/org.matrix.msc4140/delayed_events/syd_a%2Fb",
        { action: "send" },
      ],
    ]);
    for (const s of f.seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.url).not.toContain("access_token");
    }
  });

  test("a delay the homeserver no longer has is gone", async () => {
    for (const status of [400, 404]) {
      const f = fakeFetch(() => ({ status, json: { errcode: "M_NOT_FOUND" } }));
      expect(await hs(f.fetch).delayedEvent("syd_1", "restart")).toBe("gone");
    }
  });

  test("rate limited, failing or unreachable throws, without quoting the delay id", async () => {
    for (const answer of [{ status: 429 }, { status: 502 }, "throw" as const]) {
      const f = fakeFetch(() => answer);
      const error = await hs(f.fetch)
        .delayedEvent("syd_secret", "send")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallUpstreamError);
      expect(String(error)).not.toContain("syd_secret");
    }
  });
});

describe("calls: the hub's membership check (C4)", () => {
  const TOKEN = "membership-token-for-tests";
  const hub = (fetch: typeof globalThis.fetch) =>
    createMembershipCheck({
      hubUrl: "https://hub.example/",
      token: TOKEN,
      fetch,
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
    expect(f.seen).toEqual([
      {
        url: "https://hub.example/internal/superdial/membership",
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        }) as Record<string, string>,
        body: { user_id: "@u:s.example", room_id: "!r:s.example" },
      },
    ]);
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
      const error = await hub(f.fetch)
        .check("@u:s.example", "!r:s.example")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallUpstreamError);
      expect((error as CallUpstreamError).service).toBe("hub");
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
