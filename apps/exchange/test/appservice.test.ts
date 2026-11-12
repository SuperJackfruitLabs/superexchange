import { afterEach, describe, expect, test } from "bun:test";
import {
  MatrixClientError,
  countEventTypes,
  createAppserviceHandler,
  createClient,
  createCryptoTransport,
  type CryptoTransaction,
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

  const SPEAKER = "@superexchange_board:example.test";

  test("setDisplayName puts the name as the user itself", async () => {
    const { c, calls } = client(() => Response.json({}));
    await c.setDisplayName(SPEAKER, "superpipeline");
    const call = calls[0];
    expect(call?.init.method).toBe("PUT");
    expect(call?.url.pathname).toBe(
      `/_matrix/client/v3/profile/${encodeURIComponent(SPEAKER)}/displayname`,
    );
    expect(call?.url.searchParams.get("user_id")).toBe(SPEAKER);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      displayname: "superpipeline",
    });
  });

  test("createRoom makes a private room, encrypted only when asked", async () => {
    const { c, calls } = client(() =>
      Response.json({ room_id: "!r:example.test" }),
    );
    const options = {
      aliasLocalpart: "superexchange_board_brd_a",
      name: "Board A",
      topic: "Approvals",
      invite: ["@ana:example.test"],
      powerLevels: { [SPEAKER]: 100 },
    };
    expect(await c.createRoom(SPEAKER, { ...options, encrypted: true })).toBe(
      "!r:example.test",
    );
    await c.createRoom(SPEAKER, { ...options, encrypted: false });
    const [encrypted, plaintext] = calls.map(
      (call) => JSON.parse(String(call.init.body)) as Record<string, unknown>,
    );
    expect(calls[0]?.url.pathname).toBe("/_matrix/client/v3/createRoom");
    expect(calls[0]?.url.searchParams.get("user_id")).toBe(SPEAKER);
    expect(encrypted).toEqual({
      room_alias_name: "superexchange_board_brd_a",
      name: "Board A",
      topic: "Approvals",
      preset: "private_chat",
      visibility: "private",
      invite: ["@ana:example.test"],
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
      power_level_content_override: { users: { [SPEAKER]: 100 } },
    });
    expect(plaintext?.initial_state).toEqual([]);
  });

  test("createRoom on a taken alias throws M_ROOM_IN_USE", async () => {
    const { c } = client(() =>
      Response.json({ errcode: "M_ROOM_IN_USE" }, { status: 400 }),
    );
    await expect(
      c.createRoom(SPEAKER, {
        aliasLocalpart: "a",
        name: "a",
        topic: "a",
        invite: [],
        encrypted: false,
      }),
    ).rejects.toMatchObject({
      endpoint: "createRoom",
      errcode: "M_ROOM_IN_USE",
    });
  });

  test("resolveAlias answers the room, or null for an alias that points nowhere", async () => {
    const { c, calls } = client((url) =>
      url.pathname.endsWith(encodeURIComponent("#known:example.test"))
        ? Response.json({ room_id: "!r:example.test", servers: [] })
        : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 }),
    );
    expect(await c.resolveAlias("#known:example.test")).toBe("!r:example.test");
    expect(await c.resolveAlias("#gone:example.test")).toBeNull();
    expect(calls[0]?.url.pathname).toBe(
      `/_matrix/client/v3/directory/room/${encodeURIComponent("#known:example.test")}`,
    );
  });

  test("invite and joinedMembers speak as the asserted user", async () => {
    const { c, calls } = client((url) =>
      url.pathname.endsWith("/joined_members")
        ? Response.json({
            joined: { [SPEAKER]: {}, "@ana:example.test": {} },
          })
        : Response.json({}),
    );
    await c.invite(SPEAKER, "!r:example.test", "@ana:example.test");
    expect(await c.joinedMembers(SPEAKER, "!r:example.test")).toEqual([
      SPEAKER,
      "@ana:example.test",
    ]);
    expect(calls[0]?.url.pathname).toBe(
      `/_matrix/client/v3/rooms/${encodeURIComponent("!r:example.test")}/invite`,
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      user_id: "@ana:example.test",
    });
    for (const call of calls)
      expect(call.url.searchParams.get("user_id")).toBe(SPEAKER);
  });

  test("sendEvent PUTs under the caller's transaction id and answers the event id", async () => {
    const { c, calls } = client(() => Response.json({ event_id: "$e1" }));
    expect(
      await c.sendEvent(SPEAKER, "!r:example.test", "dev.x.v1", "sx/gate 1", {
        a: 1,
      }),
    ).toBe("$e1");
    const call = calls[0];
    expect(call?.init.method).toBe("PUT");
    expect(call?.url.pathname).toBe(
      `/_matrix/client/v3/rooms/${encodeURIComponent("!r:example.test")}/send/dev.x.v1/${encodeURIComponent("sx/gate 1")}`,
    );
    expect(call?.url.searchParams.get("user_id")).toBe(SPEAKER);
    expect(JSON.parse(String(call?.init.body))).toEqual({ a: 1 });
  });

  test("a refused send throws with its errcode, and a send with no event id is an error", async () => {
    const refused = client(() =>
      Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 }),
    );
    await expect(
      refused.c.sendEvent(SPEAKER, "!r:x", "t", "txn", {}),
    ).rejects.toMatchObject({
      endpoint: "send",
      status: 403,
      errcode: "M_FORBIDDEN",
    });
    const empty = client(() => Response.json({}));
    await expect(
      empty.c.sendEvent(SPEAKER, "!r:x", "t", "txn", {}),
    ).rejects.toBeInstanceOf(MatrixClientError);
  });
});

describe("a transaction's crypto parts", () => {
  function cryptoSetup(onCrypto?: (tx: CryptoTransaction) => void) {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const order: string[] = [];
    const fed: CryptoTransaction[] = [];
    const { log, lines } = captureLog();
    const handle = createAppserviceHandler({
      hsToken: HS_TOKEN,
      store: t.store,
      onEvents: () => void order.push("events"),
      onCrypto:
        onCrypto ??
        ((tx) => {
          order.push("crypto");
          fed.push(tx);
        }),
      log,
    });
    return { handle, order, fed, lines };
  }
  const KEYS = {
    events: [EVENT],
    "de.sorunome.msc2409.to_device": [
      { type: "m.room.encrypted", sender: "@ana:example.test", content: {} },
    ],
    "org.matrix.msc3202.device_one_time_keys_count": {
      "@superexchange_board:example.test": { D: { signed_curve25519: 10 } },
    },
  };

  test("are fed before the events, and again on a repeat the events are not", async () => {
    const s = cryptoSetup();
    await s.handle(put("t1", KEYS));
    await s.handle(put("t1", KEYS));
    expect(s.order).toEqual(["crypto", "events", "crypto"]);
    expect(s.fed[0]?.toDevice).toHaveLength(1);
    expect(s.fed[0]?.otkCounts).toEqual(
      KEYS["org.matrix.msc3202.device_one_time_keys_count"],
    );
  });

  test("a transaction with none is not fed", async () => {
    const s = cryptoSetup();
    await s.handle(put("t1", { events: [EVENT] }));
    expect(s.order).toEqual(["events"]);
  });

  test("a crypto step that throws still delivers the events, and its message is not logged", async () => {
    const s = cryptoSetup(() => {
      throw new Error("failed on key material");
    });
    const seen: string[] = [];
    const response = await s.handle(put("t1", KEYS));
    seen.push(String(response.status));
    expect(seen).toEqual(["200"]);
    expect(s.order).toEqual(["events"]);
    expect(s.lines.join("\n")).not.toContain("key material");
    expect(s.lines).toContain(
      'appservice: transaction "t1" crypto handler threw Error',
    );
  });
});

describe("the client's encryption calls", () => {
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
      t: createCryptoTransport({
        homeserverUrl: "https://matrix.example.test/",
        asToken: AS_TOKEN,
        fetch,
      }),
    };
  }

  test("login is an appservice login, answering only the device id", async () => {
    const { c, calls } = client(() =>
      Response.json({
        device_id: "DEV1",
        access_token: "issued-token",
        user_id: "@superexchange_board:example.test",
      }),
    );
    const answer = await c.login("superexchange_board");
    expect(answer).toEqual({ deviceId: "DEV1" });
    expect(JSON.stringify(answer)).not.toContain("issued-token");
    expect(calls[0]?.url.pathname).toBe("/_matrix/client/v3/login");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: "m.login.application_service",
      identifier: { type: "m.id.user", user: "superexchange_board" },
    });
    await expect(c.login("Not Valid")).rejects.toThrow("M_INVALID_USERNAME");
  });

  test("login that answers no device, or is refused, throws without the token", async () => {
    const none = client(() => Response.json({}));
    await expect(none.c.login("superexchange_board")).rejects.toThrow(
      "login answered 200",
    );
    const refused = client(() =>
      Response.json(
        { errcode: "M_APPSERVICE_LOGIN_UNSUPPORTED" },
        { status: 400 },
      ),
    );
    const error = await refused.c
      .login("superexchange_board")
      .catch((e: Error) => e);
    expect(String(error)).toContain("M_APPSERVICE_LOGIN_UNSUPPORTED");
    expect(String(error)).not.toContain(AS_TOKEN);
  });

  test("a room's encryption is read from its state; an answer that is not 200 or M_NOT_FOUND throws", async () => {
    const on = client(() =>
      Response.json({ algorithm: "m.megolm.v1.aes-sha2" }),
    );
    expect(await on.c.roomEncrypted("@u:example.test", "!r:example.test")).toBe(
      true,
    );
    expect(on.calls[0]?.url.pathname).toBe(
      "/_matrix/client/v3/rooms/!r%3Aexample.test/state/m.room.encryption/",
    );
    expect(on.calls[0]?.url.searchParams.get("user_id")).toBe(
      "@u:example.test",
    );
    const off = client(() =>
      Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 }),
    );
    expect(
      await off.c.roomEncrypted("@u:example.test", "!r:example.test"),
    ).toBe(false);
    for (const [status, errcode] of [
      [403, "M_FORBIDDEN"],
      [404, "M_UNRECOGNIZED"],
      [502, "M_UNKNOWN"],
    ] as const) {
      const bad = client(() => Response.json({ errcode }, { status }));
      await expect(
        bad.c.roomEncrypted("@u:example.test", "!r:example.test"),
      ).rejects.toThrow(`room_encryption answered ${status} ${errcode}`);
    }
  });

  test("the transport asserts the user and the device, and unwraps a signature upload", async () => {
    const { t, calls } = client(() => Response.json({ failures: {} }));
    await t.send("@s:example.test", "DEV1", {
      id: "r1",
      type: 4,
      body: JSON.stringify({ signed_keys: { "@s:example.test": { k: 1 } } }),
    });
    expect(calls[0]?.url.pathname).toBe(
      "/_matrix/client/v3/keys/signatures/upload",
    );
    expect(calls[0]?.url.searchParams.get("user_id")).toBe("@s:example.test");
    expect(calls[0]?.url.searchParams.get("device_id")).toBe("DEV1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      "@s:example.test": { k: 1 },
    });
    await t.send("@s:example.test", "DEV1", {
      id: "r2",
      type: 3,
      body: "{}",
      eventType: "m.room.encrypted",
      txnId: "tx/1",
    });
    expect(calls[1]?.url.pathname).toBe(
      "/_matrix/client/v3/sendToDevice/m.room.encrypted/tx%2F1",
    );
  });

  test("a refused crypto request names the endpoint and errcode, never the body or the token", async () => {
    const { t } = client(() =>
      Response.json(
        { errcode: "M_BAD_JSON", error: "key material curve25519:AAAA" },
        { status: 400 },
      ),
    );
    const error = await t
      .send("@s:example.test", "DEV1", {
        id: "r",
        type: 0,
        body: '{"secret":1}',
      })
      .catch((e: Error) => e);
    expect(String(error)).toContain("keys/upload answered 400 M_BAD_JSON");
    expect(String(error)).not.toContain("curve25519");
    expect(String(error)).not.toContain(AS_TOKEN);
    await expect(
      t.send("@s:example.test", "DEV1", { id: "r", type: 99, body: "{}" }),
    ).rejects.toThrow("crypto request 99");
  });
});
