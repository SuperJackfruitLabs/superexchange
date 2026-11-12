import { afterEach, describe, expect, test } from "bun:test";
import {
  MatrixClientError,
  countEventTypes,
  createAppserviceHandler,
  createClient,
  type MatrixEvent,
} from "../src/appservice/index.ts";
import { HS_TOKEN, captureLog, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(onEvents?: (txnId: string, events: MatrixEvent[]) => void) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const seen: Array<{ txnId: string; events: MatrixEvent[] }> = [];
  const { log, lines } = captureLog();
  const handle = createAppserviceHandler({
    hsToken: HS_TOKEN,
    store: t.store,
    onEvents:
      onEvents ?? ((txnId, events) => void seen.push({ txnId, events })),
    log,
  });
  return { handle, seen, lines, store: t.store };
}

const AS = "http://exchange/_matrix/app/v1";
const bearer = { authorization: `Bearer ${HS_TOKEN}` };

function put(
  txnId: string,
  body: unknown,
  headers: Record<string, string> = bearer,
) {
  return new Request(`${AS}/transactions/${txnId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const EVENT = {
  type: "m.room.message",
  sender: "@ana:example.test",
  room_id: "!room:example.test",
  event_id: "$e1",
  content: { body: "a private message" },
};

describe("appservice authorisation", () => {
  test("no token is 401 M_UNAUTHORIZED, on every route", async () => {
    const { handle, seen } = setup();
    for (const request of [
      put("t1", { events: [EVENT] }, {}),
      new Request(`${AS}/ping`, { method: "POST" }),
      new Request(`${AS}/users/%40a%3Aexample.test`),
      new Request(`${AS}/rooms/%23a%3Aexample.test`),
      new Request(`${AS}/ping`, {
        method: "POST",
        headers: { authorization: "Basic abc" },
      }),
    ]) {
      const response = await handle(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ errcode: "M_UNAUTHORIZED" });
    }
    expect(seen).toEqual([]);
  });

  test("a wrong token is 403 M_FORBIDDEN, and nothing is applied", async () => {
    const { handle, seen, store } = setup();
    const response = await handle(
      put("t1", { events: [EVENT] }, { authorization: "Bearer wrong" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ errcode: "M_FORBIDDEN" });
    expect(seen).toEqual([]);
    // The transaction id was not used up by the refused attempt.
    expect(store.claimTransaction("t1")).toBe(true);
  });

  test("the legacy access_token query is accepted, and checked", async () => {
    const { handle } = setup();
    const ok = await handle(
      new Request(`${AS}/ping?access_token=${HS_TOKEN}`, { method: "POST" }),
    );
    expect(ok.status).toBe(200);
    const bad = await handle(
      new Request(`${AS}/ping?access_token=nope`, { method: "POST" }),
    );
    expect(bad.status).toBe(403);
  });
});

describe("transactions", () => {
  test("events are handed over once; a repeat answers {} and is not re-applied", async () => {
    const { handle, seen, lines } = setup();
    const first = await handle(put("t1", { events: [EVENT] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});
    const again = await handle(put("t1", { events: [EVENT] }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({});
    expect(seen).toEqual([{ txnId: "t1", events: [EVENT] }]);
    expect(lines.some((l) => l.includes("already applied"))).toBe(true);
  });

  test("a handler that throws still answers {}, and its message is not logged", async () => {
    const { handle, lines } = setup(() => {
      throw new Error("failed on a private message");
    });
    const response = await handle(put("t1", { events: [EVENT] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(lines.join("\n")).not.toContain("private message");
  });

  test("malformed JSON is acknowledged and not recorded", async () => {
    const { handle, seen, store } = setup();
    const response = await handle(put("t1", "{not json"));
    expect(response.status).toBe(200);
    expect(seen).toEqual([]);
    expect(store.claimTransaction("t1")).toBe(true);
  });

  test("entries that are not events are dropped", async () => {
    const { handle, seen } = setup();
    await handle(put("t1", { events: [EVENT, 1, null, { no: "type" }] }));
    await handle(put("t2", { events: "nope" }));
    expect(seen).toEqual([
      { txnId: "t1", events: [EVENT] },
      { txnId: "t2", events: [] },
    ]);
  });

  test("a transaction id that is not valid percent-encoding is 400", async () => {
    const { handle, seen } = setup();
    const response = await handle(put("%E0%A4%A", { events: [EVENT] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errcode: "M_INVALID_PARAM" });
    expect(seen).toEqual([]);
  });

  test("only PUT is a transaction", async () => {
    const { handle } = setup();
    const response = await handle(
      new Request(`${AS}/transactions/t1`, { method: "POST", headers: bearer }),
    );
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ errcode: "M_UNRECOGNIZED" });
  });

  test("the shipped handler logs counts by type, never content, senders or rooms", () => {
    const { log, lines } = captureLog();
    countEventTypes(log)("t9", [EVENT, EVENT, { type: "m.reaction" }]);
    expect(lines).toEqual([
      'appservice: transaction "t9" with 3 event(s) {"m.room.message":2,"m.reaction":1}',
    ]);
  });
});

describe("queries and ping", () => {
  test("ping answers {}", async () => {
    const { handle } = setup();
    const response = await handle(
      new Request(`${AS}/ping`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ transaction_id: "p1" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("users and rooms are not found yet", async () => {
    const { handle } = setup();
    for (const path of [
      "users/%40a%3Aexample.test",
      "rooms/%23a%3Aexample.test",
    ]) {
      const response = await handle(
        new Request(`${AS}/${path}`, { headers: bearer }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ errcode: "M_NOT_FOUND" });
    }
  });

  test("any other path is M_UNRECOGNIZED", async () => {
    const { handle } = setup();
    for (const path of [
      "thirdparty/protocol/x",
      "transactions",
      "ping/extra",
    ]) {
      const response = await handle(
        new Request(`${AS}/${path}`, { headers: bearer }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ errcode: "M_UNRECOGNIZED" });
    }
  });
});

describe("the client-server client", () => {
  const AS_TOKEN = "as-token-for-tests";
  function client(answer: (url: URL, init: RequestInit) => Response) {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return answer(url, init ?? {});
    }) as typeof globalThis.fetch;
    return {
      calls,
      c: createClient({
        homeserverUrl: "https://matrix.example.test/",
        serverName: "example.test",
        asToken: AS_TOKEN,
        fetch,
      }),
    };
  }

  test("whoami sends the as_token and asserts the user", async () => {
    const { c, calls } = client(() =>
      Response.json({ user_id: "@exchange_a:example.test" }),
    );
    expect(await c.whoami("@exchange_a:example.test")).toEqual({
      userId: "@exchange_a:example.test",
    });
    const call = calls[0];
    expect(call?.url.pathname).toBe("/_matrix/client/v3/account/whoami");
    expect(call?.url.searchParams.get("user_id")).toBe(
      "@exchange_a:example.test",
    );
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      `Bearer ${AS_TOKEN}`,
    );
  });

  test("whoami refuses an answer for somebody else", async () => {
    const { c } = client(() =>
      Response.json({ user_id: "@other:example.test" }),
    );
    await expect(c.whoami("@exchange_a:example.test")).rejects.toMatchObject({
      errcode: "M_WRONG_USER",
    });
  });

  test("register uses m.login.application_service, and an existing user is not an error", async () => {
    const { c, calls } = client((_url, init) => {
      const body = JSON.parse(String(init.body)) as { username: string };
      return body.username === "taken"
        ? Response.json({ errcode: "M_USER_IN_USE" }, { status: 400 })
        : Response.json({ user_id: `@${body.username}:example.test` });
    });
    expect(await c.register("exchange_a")).toEqual({
      userId: "@exchange_a:example.test",
      created: true,
    });
    expect(await c.register("taken")).toEqual({
      userId: "@taken:example.test",
      created: false,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: "m.login.application_service",
      username: "exchange_a",
      inhibit_login: true,
    });
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/_matrix/client/v3/register");
  });

  test("register refuses a localpart the spec does not allow, without calling", async () => {
    const { c, calls } = client(() => Response.json({}));
    await expect(c.register("Upper:case")).rejects.toBeInstanceOf(
      MatrixClientError,
    );
    expect(calls).toEqual([]);
  });

  test("an error names the endpoint and errcode, never the token", async () => {
    const { c } = client(() =>
      Response.json(
        { errcode: "M_UNKNOWN_TOKEN", error: AS_TOKEN },
        { status: 401 },
      ),
    );
    let message = "";
    try {
      await c.whoami();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("whoami answered 401 M_UNKNOWN_TOKEN");
    expect(message).not.toContain(AS_TOKEN);
  });
});
