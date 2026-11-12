import { afterEach, describe, expect, test } from "bun:test";
import {
  GATE_EVENT_TYPE,
  GATE_REQUEST_CONTENT_KEY,
  gateEventContent,
  gateRequestCard,
  gateV2Content,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import { createClient, type MatrixEvent } from "../src/appservice/index.ts";
import {
  createBoardChat,
  createBoardRooms,
  gateTxnId,
} from "../src/board-chat/index.ts";
import type { Store } from "../src/store/index.ts";
import { captureLog, gateBody, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const SERVER = "staging-matrix.example.test";
const SPEAKER = `@superexchange_board:${SERVER}`;
const ANA = `@ana:${SERVER}`;
const BO = `@bo:${SERVER}`;
const AS_TOKEN = "as-token-for-tests";

interface Call {
  method: string;
  path: string;
  userId: string | null;
  body: Record<string, unknown> | null;
}

/**
 * A homeserver just large enough for board rooms: register, display names, createRoom (aliases
 * claimed once), directory, invite, joined_members, and send, which answers a repeated
 * transaction id with the first send's event id as the spec says.
 */
function fakeHomeserver() {
  const calls: Call[] = [];
  const aliases = new Map<string, string>();
  const joined = new Map<string, Set<string>>();
  const txns = new Map<string, string>();
  const sent: Array<{
    roomId: string;
    type: string;
    content: Record<string, unknown>;
  }> = [];
  /** Answer every call whose path or body contains the key with this status instead. */
  const failures = new Map<string, number>();
  let rooms = 0;
  let events = 0;

  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    const path = decodeURIComponent(url.pathname);
    calls.push({ method, path, userId: url.searchParams.get("user_id"), body });
    const as = url.searchParams.get("user_id") ?? "";

    const haystack = `${url.pathname} ${String(init?.body ?? "")}`;
    for (const [segment, status] of failures) {
      if (haystack.includes(segment)) {
        return Response.json({ errcode: "M_UNKNOWN" }, { status });
      }
    }

    if (path === "/_matrix/client/v3/register") {
      return Response.json({ user_id: `@${String(body?.username)}:${SERVER}` });
    }
    if (path.endsWith("/displayname")) return Response.json({});
    if (path === "/_matrix/client/v3/createRoom") {
      const alias = `#${String(body?.room_alias_name)}:${SERVER}`;
      if (aliases.has(alias))
        return Response.json({ errcode: "M_ROOM_IN_USE" }, { status: 400 });
      const roomId = `!room${++rooms}:${SERVER}`;
      aliases.set(alias, roomId);
      joined.set(roomId, new Set([as]));
      return Response.json({ room_id: roomId });
    }
    const directory = /^\/_matrix\/client\/v3\/directory\/room\/(.+)$/.exec(
      path,
    );
    if (directory) {
      const roomId = aliases.get(directory[1] as string);
      return roomId
        ? Response.json({ room_id: roomId })
        : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
    }
    const roomPath =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(invite|joined_members|send)(?:\/([^/]+)\/(.+))?$/.exec(
        path,
      );
    if (roomPath) {
      const [, roomId, what, type, txnId] = roomPath as unknown as string[];
      if (what === "invite") return Response.json({});
      if (what === "joined_members") {
        const members = Object.fromEntries(
          [...(joined.get(roomId as string) ?? [])].map((m) => [m, {}]),
        );
        return Response.json({ joined: members });
      }
      const key = `${as}|${txnId}`;
      const known = txns.get(key);
      if (known) return Response.json({ event_id: known });
      const eventId = `$event${++events}`;
      txns.set(key, eventId);
      sent.push({
        roomId: roomId as string,
        type: type as string,
        content: body ?? {},
      });
      return Response.json({ event_id: eventId });
    }
    return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    sent,
    failures,
    aliases,
    /** A person accepting the invite, as the homeserver sees it. */
    join(roomId: string, userId: string) {
      joined.get(roomId)?.add(userId);
    },
    callsTo: (segment: string) => calls.filter((c) => c.path.includes(segment)),
  };
}

function setup({
  plaintextRooms = true,
  invitees = [ANA, BO],
}: { plaintextRooms?: boolean; invitees?: string[] } = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const hs = fakeHomeserver();
  const { log, lines } = captureLog();
  const client = createClient({
    homeserverUrl: "http://homeserver.test",
    serverName: SERVER,
    asToken: AS_TOKEN,
    fetch: hs.fetch,
  });
  const rooms = createBoardRooms({
    store: t.store,
    client,
    serverName: SERVER,
    log,
  });
  const chat = createBoardChat({
    store: t.store,
    client,
    rooms,
    plaintextRooms,
    log,
  });
  t.store.upsertBoard({
    boardId: "brd_7c1f",
    spTenantId: "tnt_1",
    orgId: "org_1",
    invitees,
  });
  return { store: t.store, hs, chat, rooms, lines, client };
}

function deliver(
  store: Store,
  overrides: Record<string, unknown> = {},
): GatePendingDelivery {
  const body = gateBody(overrides) as unknown as GatePendingDelivery;
  store.recordGateDelivery(body.gateId, body.boardId, body);
  return body;
}

function memberEvent(
  roomId: string,
  userId: string,
  membership: string,
): MatrixEvent {
  return {
    type: "m.room.member",
    room_id: roomId,
    sender: userId,
    state_key: userId,
    content: { membership },
  };
}

/** Make the board's room and have Ana join it, so the next post is not held. */
async function roomWithAnaJoined(s: ReturnType<typeof setup>) {
  const board = s.store.getBoard("brd_7c1f");
  if (board === null) throw new Error("no board");
  const room = await s.rooms.ensure(board);
  s.hs.join(room.roomId, ANA);
  await s.chat.onEvents("t-join", [memberEvent(room.roomId, ANA, "join")]);
  await s.chat.idle();
  return room;
}

describe("plaintext rooms off (the default): fail closed", () => {
  test("nothing is made or posted, and the gate stays recorded and unposted", async () => {
    const s = setup({ plaintextRooms: false });
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "refused",
      reason: "plaintext rooms off",
    });
    expect(s.hs.calls).toEqual([]);
    expect(s.store.boardRoom("brd_7c1f")).toBeNull();
    expect(s.store.gateEvent("gte_1")).toBeNull();
    expect(s.store.unpostedGates().map((g) => g.gateId)).toEqual(["gte_1"]);
  });

  test("the refusal is logged once per board", async () => {
    const s = setup({ plaintextRooms: false });
    deliver(s.store);
    deliver(s.store, { gateId: "gte_2" });
    s.chat.resume();
    await s.chat.idle();
    await s.chat.post("gte_1");
    const refusals = s.lines.filter((l) => l.includes("encryption"));
    expect(refusals).toEqual([
      "board-chat: brd_7c1f has gates to post, and end-to-end encryption is not available yet: nothing is posted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
    ]);
  });
});

describe("the board's room", () => {
  test("is made once by the speaker under treaty's names, without encryption, and its people invited", async () => {
    const s = setup();
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "held" });

    expect(s.hs.callsTo("/register")[0]?.body).toMatchObject({
      type: "m.login.application_service",
      username: "superexchange_board",
    });
    expect(s.hs.callsTo("/displayname")[0]).toMatchObject({
      userId: SPEAKER,
      body: { displayname: "superpipeline" },
    });
    const [create] = s.hs.callsTo("/createRoom");
    expect(create?.userId).toBe(SPEAKER);
    expect(create?.body).toMatchObject({
      room_alias_name: "superexchange_board_brd_7c1f",
      preset: "private_chat",
      visibility: "private",
      invite: [ANA],
      initial_state: [],
      power_level_content_override: { users: { [SPEAKER]: 100 } },
    });
    // The rest are invited one by one, as the speaker.
    const invites = s.hs.callsTo("/invite");
    expect(invites.map((c) => c.body?.user_id)).toEqual([BO]);
    expect(invites.every((c) => c.userId === SPEAKER)).toBe(true);

    const room = s.store.boardRoom("brd_7c1f");
    expect(room?.alias).toBe("superexchange_board_brd_7c1f");

    // A second gate uses the same room and invites nobody twice.
    deliver(s.store, { gateId: "gte_2" });
    await s.chat.post("gte_2");
    expect(s.hs.callsTo("/createRoom")).toHaveLength(1);
    expect(s.hs.callsTo("/invite")).toHaveLength(1);
  });

  test("an alias already taken is the room an earlier, unrecorded try made", async () => {
    const s = setup();
    s.hs.aliases.set(
      `#superexchange_board_brd_7c1f:${SERVER}`,
      `!earlier:${SERVER}`,
    );
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "held",
      roomId: `!earlier:${SERVER}`,
    });
    expect(s.store.boardRoom("brd_7c1f")?.roomId).toBe(`!earlier:${SERVER}`);
    // Nobody rode on a create, so everybody is invited.
    expect(s.hs.callsTo("/invite").map((c) => c.body?.user_id)).toEqual([
      ANA,
      BO,
    ]);
  });

  test("an invitee the homeserver refuses costs nobody else their invite", async () => {
    const s = setup({ invitees: [ANA, BO, `@cy:${SERVER}`] });
    s.hs.failures.set(`"user_id":"${BO}"`, 403);
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "held" });
    const roomId = s.store.boardRoom("brd_7c1f")!.roomId;
    expect(s.hs.callsTo("/invite").map((c) => c.body?.user_id)).toEqual([
      BO,
      `@cy:${SERVER}`,
    ]);
    expect(s.store.membershipOf(roomId, BO)).toBeNull();
    expect(s.store.membershipOf(roomId, `@cy:${SERVER}`)).toBe("invite");
    // Not invited, so the next gate tries Bo again.
    s.hs.failures.clear();
    deliver(s.store, { gateId: "gte_2" });
    await s.chat.post("gte_2");
    expect(s.store.membershipOf(roomId, BO)).toBe("invite");
  });

  test("a room that cannot be made posts nothing and claims nothing", async () => {
    const s = setup();
    s.hs.failures.set("/createRoom", 500);
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "failed",
      step: "room",
    });
    expect(s.store.gateEvent("gte_1")).toBeNull();
    expect(s.hs.callsTo("/send")).toEqual([]);
    expect(s.lines.join("\n")).not.toContain(AS_TOKEN);
  });
});

describe("held until a person joins", () => {
  test("a gate is held, without a claim, while only invitations stand", async () => {
    const s = setup();
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "held" });
    expect(s.store.gateEvent("gte_1")).toBeNull();
    expect(s.hs.callsTo("/send")).toEqual([]);
  });

  test("a person's join, seen in a transaction, posts the held gates", async () => {
    const s = setup();
    const gate = deliver(s.store);
    await s.chat.post("gte_1");
    const roomId = s.store.boardRoom("brd_7c1f")!.roomId;

    s.hs.join(roomId, ANA);
    await s.chat.onEvents("t1", [memberEvent(roomId, ANA, "join")]);
    await s.chat.idle();

    expect(s.store.membershipOf(roomId, ANA)).toBe("join");
    expect(s.hs.sent.map((e) => e.type)).toEqual([
      "m.room.message",
      GATE_EVENT_TYPE,
    ]);
    // Both built by treaty, nothing added or dropped.
    expect(s.hs.sent[0]?.content).toEqual({
      ...gateV2Content(gate),
      [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(gate),
    });
    expect(s.hs.sent[1]?.content).toEqual(gateEventContent(gate));
    expect(s.store.gateEvent("gte_1")).toMatchObject({
      roomId,
      proseEventId: "$event1",
      cardEventId: "$event2",
    });
    expect(s.store.gateEvent("gte_1")?.postedAt).not.toBeNull();
    expect(s.store.unpostedGates()).toEqual([]);
  });

  test("this service's own join wakes nothing", async () => {
    const s = setup();
    deliver(s.store);
    await s.chat.post("gte_1");
    const roomId = s.store.boardRoom("brd_7c1f")!.roomId;
    await s.chat.onEvents("t1", [
      memberEvent(roomId, SPEAKER, "join"),
      memberEvent(roomId, `@superexchange_other:${SERVER}`, "join"),
      memberEvent(roomId, ANA, "invite"),
    ]);
    await s.chat.idle();
    expect(s.hs.callsTo("/send")).toEqual([]);
  });

  test("a join into a room that is not a board's is not recorded", async () => {
    const s = setup();
    await s.chat.onEvents("t1", [memberEvent(`!other:${SERVER}`, ANA, "join")]);
    expect(s.store.membershipOf(`!other:${SERVER}`, ANA)).toBeNull();
  });

  test("a join the transactions missed is found by asking the room", async () => {
    const s = setup();
    deliver(s.store);
    await s.chat.post("gte_1");
    const roomId = s.store.boardRoom("brd_7c1f")!.roomId;
    s.hs.join(roomId, ANA);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "posted" });
    expect(s.store.membershipOf(roomId, ANA)).toBe("join");
  });

  test("members that cannot be read hold the gate", async () => {
    const s = setup();
    deliver(s.store);
    s.hs.failures.set("/joined_members", 502);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "failed",
      step: "membership",
    });
    expect(s.hs.callsTo("/send")).toEqual([]);
  });
});

describe("posted exactly once", () => {
  test("a gate already posted is never sent again", async () => {
    const s = setup();
    await roomWithAnaJoined(s);
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "posted" });
    const sends = s.hs.callsTo("/send").length;
    expect(await s.chat.post("gte_1")).toEqual({ status: "already" });
    s.chat.resume();
    s.chat.gateAccepted("gte_1");
    await s.chat.idle();
    expect(s.hs.callsTo("/send")).toHaveLength(sends);
    expect(s.hs.sent).toHaveLength(2);
  });

  test("two posts of one gate at once send it once", async () => {
    const s = setup();
    await roomWithAnaJoined(s);
    deliver(s.store);
    const outcomes = await Promise.all([
      s.chat.post("gte_1"),
      s.chat.post("gte_1"),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["posted", "already"]);
    expect(s.hs.sent).toHaveLength(2);
  });

  test("a failed card send keeps the claim, and the retry sends only the card under the same id", async () => {
    const s = setup();
    const room = await roomWithAnaJoined(s);
    deliver(s.store);
    s.hs.failures.set(encodeURIComponent(GATE_EVENT_TYPE), 502);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "failed",
      step: "send",
    });
    expect(s.store.gateEvent("gte_1")).toMatchObject({
      roomId: room.roomId,
      proseEventId: "$event1",
      cardEventId: null,
      postedAt: null,
    });
    expect(s.store.unpostedGates().map((g) => g.gateId)).toEqual(["gte_1"]);

    s.hs.failures.clear();
    s.chat.resume();
    await s.chat.idle();
    expect(s.store.gateEvent("gte_1")?.postedAt).not.toBeNull();
    // One prose, one card: the prose was not sent again, not even under its own id.
    expect(s.hs.callsTo("/send/m.room.message")).toHaveLength(1);
    expect(s.hs.sent.map((e) => e.type)).toEqual([
      "m.room.message",
      GATE_EVENT_TYPE,
    ]);
    const cardTxns = s.hs
      .callsTo("/send/")
      .filter((c) => c.path.includes(GATE_EVENT_TYPE))
      .map((c) => c.path.split("/").pop());
    expect(cardTxns).toEqual([
      gateTxnId("gte_1", "card"),
      gateTxnId("gte_1", "card"),
    ]);
  });

  test("a prose send whose answer was lost is deduplicated by its transaction id", async () => {
    const s = setup();
    await roomWithAnaJoined(s);
    deliver(s.store);
    // The homeserver took the prose, and the answer never arrived: as if this process died after
    // sending and before recording.
    expect(
      s.store.claimGateEvent(
        "gte_1",
        "brd_7c1f",
        s.store.boardRoom("brd_7c1f")!.roomId,
      ),
    ).toBe(true);
    await s.client.sendEvent(
      SPEAKER,
      s.store.boardRoom("brd_7c1f")!.roomId,
      "m.room.message",
      gateTxnId("gte_1", "prose"),
      { body: "first try" },
    );
    expect(await s.chat.post("gte_1")).toMatchObject({
      status: "posted",
      proseEventId: "$event1",
    });
    expect(s.hs.sent).toHaveLength(2);
  });

  test("a claimed gate is retried at boot even if nobody joins again", async () => {
    const s = setup();
    const room = await roomWithAnaJoined(s);
    deliver(s.store);
    s.hs.failures.set("/send", 502);
    await s.chat.post("gte_1");
    s.hs.failures.clear();
    s.store.recordMembership(room.roomId, ANA, "leave");
    s.chat.resume();
    await s.chat.idle();
    expect(s.store.gateEvent("gte_1")?.postedAt).not.toBeNull();
  });
});

describe("what is not posted", () => {
  test("a disabled board's gate, and a gate that was never delivered", async () => {
    const s = setup();
    deliver(s.store);
    s.store.disableBoard("brd_7c1f");
    expect(await s.chat.post("gte_1")).toEqual({
      status: "skipped",
      reason: "board disabled",
    });
    expect(await s.chat.post("gte_missing")).toEqual({
      status: "skipped",
      reason: "not delivered",
    });
    expect(s.hs.calls).toEqual([]);
  });

  test("no log line carries a setting's value", async () => {
    const s = setup();
    s.hs.failures.set("/send", 403);
    await roomWithAnaJoined(s);
    deliver(s.store);
    await s.chat.post("gte_1");
    const all = s.lines.join("\n");
    expect(all).not.toContain(AS_TOKEN);
    expect(all).not.toContain(SERVER);
    expect(all).toContain("send answered 403 M_UNKNOWN");
  });
});
