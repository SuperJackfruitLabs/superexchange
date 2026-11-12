import { afterEach, describe, expect, test } from "bun:test";
import {
  GATE_EVENT_TYPE,
  GATE_REQUEST_CONTENT_KEY,
  gateEventContent,
  gateRequestCard,
  gateV2Content,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  createClient,
  type MatrixEvent,
  type RoomCrypto,
} from "../src/appservice/index.ts";
import {
  PENDING_MAX,
  PENDING_TTL_MS,
  createBoardChat,
  createBoardRooms,
  createRoomSender,
  gateOffer,
  gateTxnId,
  type GateAnswers,
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
  /** Rooms whose state holds `m.room.encryption`. */
  const encryptedRooms = new Set<string>();
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
      const initial = (body?.initial_state ?? []) as Array<{ type?: string }>;
      if (initial.some((e) => e.type === "m.room.encryption"))
        encryptedRooms.add(roomId);
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
    const state =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.encryption\/$/.exec(
        path,
      );
    if (state) {
      return encryptedRooms.has(state[1] as string)
        ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" })
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
    encryptedRooms,
    /** A person accepting the invite, as the homeserver sees it. */
    join(roomId: string, userId: string) {
      joined.get(roomId)?.add(userId);
    },
    callsTo: (segment: string) => calls.filter((c) => c.path.includes(segment)),
  };
}

/**
 * Encryption without a machine: an envelope that names its session and carries the event, and a
 * decrypt that opens only sessions whose key has "arrived". The real machine is crypto.test.ts's.
 */
function fakeCrypto() {
  const encrypted: Array<{
    roomId: string;
    members: string[];
    eventType: string;
    content: Record<string, unknown>;
  }> = [];
  const keys = new Set<string>();
  let failing = false;
  const crypto: RoomCrypto = {
    async encrypt(roomId, members, eventType, content) {
      encrypted.push({ roomId, members, eventType, content });
      return {
        algorithm: "m.megolm.v1.aes-sha2",
        session_id: "outbound",
        ciphertext: JSON.stringify({ type: eventType, content }),
      };
    },
    async decrypt(event) {
      if (failing) throw new Error("the machine is broken");
      const c = event.content as { session_id?: string; ciphertext?: string };
      if (!c?.session_id || !keys.has(c.session_id)) return null;
      return JSON.parse(String(c.ciphertext)) as {
        type: string;
        content: Record<string, unknown>;
      };
    },
  };
  return {
    crypto,
    encrypted,
    /** The room key for a session arrives. */
    giveKey: (sessionId: string) => keys.add(sessionId),
    breakMachine: () => {
      failing = true;
    },
  };
}

/** A person's encrypted message, as the homeserver delivers it. */
function encryptedEvent(
  roomId: string,
  sender: string,
  content: Record<string, unknown>,
  { eventId = "$enc1", sessionId = "ana-session" } = {},
): MatrixEvent {
  return {
    type: "m.room.encrypted",
    room_id: roomId,
    sender,
    event_id: eventId,
    content: {
      algorithm: "m.megolm.v1.aes-sha2",
      session_id: sessionId,
      ciphertext: JSON.stringify({ type: "m.room.message", content }),
    },
  };
}

/** Answers that only record what reached them: an answer is any message with `answer` in it. */
function recordingAnswers() {
  const handled: MatrixEvent[] = [];
  const answers: GateAnswers = {
    isAnswer: (e) =>
      e.type === "m.room.message" &&
      typeof (e.content as { answer?: unknown })?.answer === "string",
    handle: async (e) => {
      handled.push(e);
      return { status: "resolved" };
    },
    resume: () => undefined,
  };
  return { answers, handled };
}

function setup({
  plaintextRooms = true,
  invitees = [ANA, BO],
  crypto = null,
  answers,
  now,
  store: given,
}: {
  plaintextRooms?: boolean;
  invitees?: string[];
  crypto?: RoomCrypto | null;
  answers?: GateAnswers;
  now?: () => Date;
  store?: Store;
} = {}) {
  const t = given ? { store: given, cleanup: () => undefined } : tempStore();
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
    encryptNewRooms: !plaintextRooms,
    log,
  });
  const chat = createBoardChat({
    store: t.store,
    sender: createRoomSender({
      store: t.store,
      client,
      crypto,
      plaintextRooms,
    }),
    rooms,
    crypto,
    log,
    ...(answers ? { answers } : {}),
    ...(now ? { now } : {}),
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

describe("encrypted board rooms (plaintext rooms off, the default)", () => {
  function encryptedSetup(
    options: Omit<Parameters<typeof setup>[0] & object, "crypto"> = {},
  ) {
    const c = fakeCrypto();
    const s = setup({ plaintextRooms: false, crypto: c.crypto, ...options });
    return { ...s, c };
  }

  test("a new room is made with Megolm in its initial state, and recorded encrypted", async () => {
    const s = encryptedSetup();
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "held" });
    expect(s.hs.callsTo("/createRoom")[0]?.body?.initial_state).toEqual([
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ]);
    expect(s.store.boardRoom("brd_7c1f")?.encrypted).toBe(true);
    expect(s.lines).toContain("board-chat: brd_7c1f room made, encrypted");
  });

  test("the gate's prose and card go out encrypted, under the gate's transaction ids, to everyone joined or invited", async () => {
    const s = encryptedSetup();
    const room = await roomWithAnaJoined(s);
    const gate = deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "posted" });

    // Nothing in the clear: every send is an envelope.
    expect(s.hs.sent.map((e) => e.type)).toEqual([
      "m.room.encrypted",
      "m.room.encrypted",
    ]);
    expect(s.c.encrypted.map((e) => e.eventType)).toEqual([
      "m.room.message",
      GATE_EVENT_TYPE,
    ]);
    // What is encrypted is treaty's content, unchanged.
    expect(s.c.encrypted[0]?.content).toEqual({
      ...gateV2Content(gate),
      [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(gate),
    });
    expect(s.c.encrypted[1]?.content).toEqual(gateEventContent(gate));
    // The speaker, Ana who joined, and Bo who is invited and not yet joined.
    expect(s.c.encrypted[0]?.members.toSorted()).toEqual(
      [ANA, BO, SPEAKER].toSorted(),
    );
    expect(s.c.encrypted.every((e) => e.roomId === room.roomId)).toBe(true);
    const txns = s.hs
      .callsTo("/send/m.room.encrypted/")
      .map((c) => c.path.split("/").pop());
    expect(txns).toEqual([
      gateTxnId("gte_1", "prose"),
      gateTxnId("gte_1", "card"),
    ]);
  });

  test("a room made in plaintext earlier is left as it is: nothing is posted into it, encrypted or not, and that is logged once", async () => {
    const s = encryptedSetup();
    s.store.recordBoardRoom(
      "brd_7c1f",
      `!old:${SERVER}`,
      "superexchange_board_brd_7c1f",
      false,
    );
    s.store.recordMembership(`!old:${SERVER}`, ANA, "join");
    deliver(s.store);
    deliver(s.store, { gateId: "gte_2" });
    expect(await s.chat.post("gte_1")).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    s.chat.resume();
    await s.chat.idle();
    expect(s.hs.calls).toEqual([]);
    expect(s.c.encrypted).toEqual([]);
    expect(s.store.gateEvent("gte_1")).toBeNull();
    expect(s.store.unpostedGates().map((g) => g.gateId)).toEqual([
      "gte_1",
      "gte_2",
    ]);
    expect(s.lines.filter((l) => l.includes("left as it is"))).toEqual([
      "board-chat: brd_7c1f's room was made without encryption and is left as it is: nothing is posted into it while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
    ]);
  });

  test("an encrypted room never gets plaintext, even with plaintext rooms on", async () => {
    const c = fakeCrypto();
    const s = setup({ plaintextRooms: true, crypto: c.crypto });
    s.store.recordBoardRoom(
      "brd_7c1f",
      `!enc:${SERVER}`,
      "superexchange_board_brd_7c1f",
      true,
    );
    s.hs.join(`!enc:${SERVER}`, ANA);
    s.store.recordMembership(`!enc:${SERVER}`, ANA, "join");
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "posted" });
    expect(s.hs.sent.map((e) => e.type)).toEqual([
      "m.room.encrypted",
      "m.room.encrypted",
    ]);
  });

  test("an encrypted room without the speaker's keys is not posted into", async () => {
    const s = setup({ plaintextRooms: true, crypto: null });
    s.store.recordBoardRoom(
      "brd_7c1f",
      `!enc:${SERVER}`,
      "superexchange_board_brd_7c1f",
      true,
    );
    s.store.recordMembership(`!enc:${SERVER}`, ANA, "join");
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "refused",
      reason: "encryption unavailable",
    });
    expect(s.hs.calls).toEqual([]);
    expect(s.lines).toContain(
      "board-chat: brd_7c1f's room is encrypted and the speaker has no keys (SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set): nothing is posted into it",
    );
  });

  test("a room found by its alias is recorded as its state says", async () => {
    for (const [encrypted, plaintextRooms] of [
      [true, true],
      [false, false],
    ] as const) {
      const c = fakeCrypto();
      const s = setup({ plaintextRooms, crypto: c.crypto });
      s.hs.aliases.set(
        `#superexchange_board_brd_7c1f:${SERVER}`,
        `!earlier:${SERVER}`,
      );
      if (encrypted) s.hs.encryptedRooms.add(`!earlier:${SERVER}`);
      deliver(s.store);
      await s.chat.post("gte_1");
      expect(s.store.boardRoom("brd_7c1f")).toMatchObject({
        roomId: `!earlier:${SERVER}`,
        encrypted,
      });
    }
  });

  test("a room whose encryption cannot be read is not recorded", async () => {
    const s = encryptedSetup();
    s.hs.aliases.set(
      `#superexchange_board_brd_7c1f:${SERVER}`,
      `!earlier:${SERVER}`,
    );
    s.hs.failures.set("/state/m.room.encryption", 500);
    deliver(s.store);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "failed",
      step: "room",
    });
    expect(s.store.boardRoom("brd_7c1f")).toBeNull();
  });

  test("an encrypted send whose room members cannot be read is not sent", async () => {
    const s = encryptedSetup();
    await roomWithAnaJoined(s);
    deliver(s.store);
    s.hs.failures.set("/joined_members", 502);
    expect(await s.chat.post("gte_1")).toEqual({
      status: "failed",
      step: "send",
    });
    expect(s.hs.sent).toEqual([]);
    expect(s.c.encrypted).toEqual([]);
  });
});

describe("encrypted events coming in", () => {
  function inbound(options: { now?: () => Date } = {}) {
    const c = fakeCrypto();
    const a = recordingAnswers();
    const s = setup({
      plaintextRooms: false,
      crypto: c.crypto,
      answers: a.answers,
      ...options,
    });
    s.store.recordBoardRoom(
      "brd_7c1f",
      ROOM_ID,
      "superexchange_board_brd_7c1f",
      true,
    );
    return { ...s, c, handled: a.handled };
  }
  const ROOM_ID = `!board:${SERVER}`;

  test("an answer is decrypted before it is read, and keeps its envelope's sender, room and id", async () => {
    const s = inbound();
    s.c.giveKey("ana-session");
    await s.chat.onEvents("t1", [
      encryptedEvent(ROOM_ID, ANA, { msgtype: "m.text", answer: "approve" }),
    ]);
    await s.chat.idle();
    expect(s.handled).toEqual([
      {
        type: "m.room.message",
        room_id: ROOM_ID,
        sender: ANA,
        event_id: "$enc1",
        content: { msgtype: "m.text", answer: "approve" },
      },
    ]);
    expect(s.store.pendingDecrypts()).toEqual([]);
  });

  test("one whose key has not arrived waits in the store, still encrypted, logged once without its content", async () => {
    const s = inbound();
    const event = encryptedEvent(ROOM_ID, ANA, { answer: "secret-answer" });
    await s.chat.onEvents("t1", [event]);
    await s.chat.onEvents("t2", [event]);
    await s.chat.idle();
    expect(s.handled).toEqual([]);
    expect(s.store.pendingDecrypts()).toMatchObject([
      { eventId: "$enc1", roomId: ROOM_ID, event },
    ]);
    const parked = s.lines.filter((l) => l.includes("waits for its key"));
    expect(parked).toEqual([
      "board-chat: an encrypted event in the room of brd_7c1f cannot be decrypted yet; it waits for its key",
    ]);
    expect(s.lines.join("\n")).not.toContain("secret-answer");

    // The key arrives: it is read once, and leaves the store.
    s.c.giveKey("ana-session");
    await s.chat.retryPending();
    await s.chat.retryPending();
    await s.chat.idle();
    expect(s.handled.map((e) => e.event_id)).toEqual(["$enc1"]);
    expect(s.store.pendingDecrypts()).toEqual([]);
  });

  test("a waiting event outlives a restart, and is read at boot once its key is here", async () => {
    const first = inbound();
    await first.chat.onEvents("t1", [
      encryptedEvent(ROOM_ID, ANA, { answer: "approve" }),
    ]);
    await first.chat.idle();

    const c = fakeCrypto();
    c.giveKey("ana-session");
    const a = recordingAnswers();
    const again = setup({
      plaintextRooms: false,
      crypto: c.crypto,
      answers: a.answers,
      store: first.store,
    });
    again.chat.resume();
    await again.chat.idle();
    expect(a.handled.map((e) => e.event_id)).toEqual(["$enc1"]);
    expect(first.store.pendingDecrypts()).toEqual([]);
  });

  test("an event that never gets its key is given up after the wait, and not read", async () => {
    let at = new Date("2026-11-12T10:00:00.000Z");
    const s = inbound({ now: () => at });
    await s.chat.onEvents("t1", [
      encryptedEvent(ROOM_ID, ANA, { answer: "approve" }),
    ]);
    await s.chat.idle();
    s.store.pendingDecrypts(); // parked with the store's own clock
    at = new Date(Date.now() + PENDING_TTL_MS + 60_000);
    s.c.giveKey("ana-session");
    await s.chat.retryPending();
    await s.chat.idle();
    expect(s.handled).toEqual([]);
    expect(s.store.pendingDecrypts()).toEqual([]);
    expect(s.lines).toContain(
      "board-chat: an encrypted event in the room of brd_7c1f never got its key; given up",
    );
  });

  test("a machine that cannot decrypt parks the event rather than losing it", async () => {
    const s = inbound();
    s.c.breakMachine();
    await s.chat.onEvents("t1", [
      encryptedEvent(ROOM_ID, ANA, { answer: "approve" }),
    ]);
    await s.chat.idle();
    expect(s.store.pendingDecrypts()).toHaveLength(1);
    expect(s.lines).toContain(
      "board-chat: an encrypted event could not be decrypted (Error)",
    );
  });

  test("this service's own events, and rooms that are not a board's, are neither decrypted nor parked", async () => {
    const s = inbound();
    s.c.giveKey("ana-session");
    await s.chat.onEvents("t1", [
      encryptedEvent(
        ROOM_ID,
        SPEAKER,
        { answer: "approve" },
        { eventId: "$a" },
      ),
      encryptedEvent(
        ROOM_ID,
        `@superexchange_other:${SERVER}`,
        { answer: "approve" },
        { eventId: "$b" },
      ),
      encryptedEvent(
        `!other:${SERVER}`,
        ANA,
        { answer: "approve" },
        { eventId: "$c" },
      ),
    ]);
    await s.chat.idle();
    expect(s.handled).toEqual([]);
    expect(s.store.pendingDecrypts()).toEqual([]);
  });

  test("at most PENDING_MAX wait: the oldest go first", () => {
    const s = inbound();
    for (let i = 0; i < PENDING_MAX + 2; i++) {
      s.store.parkPendingDecrypt(
        `$e${String(i).padStart(4, "0")}`,
        ROOM_ID,
        {},
        PENDING_MAX,
      );
    }
    const left = s.store.pendingDecrypts();
    expect(left).toHaveLength(PENDING_MAX);
    expect(left.map((r) => r.eventId)).not.toContain("$e0000");
    expect(left.map((r) => r.eventId)).toContain(
      `$e${String(PENDING_MAX + 1).padStart(4, "0")}`,
    );
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
    // What it offered is recorded with the claim: an answer is checked against it.
    expect(s.store.gateEvent("gte_1")?.offer).toEqual({
      options: [
        {
          id: "approve",
          label: "Approve",
          meaning: "approve",
          needs_comment: false,
        },
        {
          id: "request_changes",
          label: "Request changes",
          meaning: "revise",
          needs_comment: true,
        },
        {
          id: "reject",
          label: "Reject",
          meaning: "reject",
          needs_comment: false,
        },
      ],
      subjectId: null,
      subjectDigest: null,
      subjectPreviewComplete: null,
      variants: null,
      quorum: null,
    });
  });

  test("a subject-bound gate's subject and quorum are recorded as its gate.v2 carries them", async () => {
    const s = setup();
    await roomWithAnaJoined(s);
    const gate = deliver(s.store, {
      approvalSubject: {
        id: "aps_1",
        digest: "sha256:1",
        schema: "x.post.v1",
        revision: 1,
        expiresAt: null,
        preview: [{ type: "text", text: "Hello" }],
      },
      quorum: { required: 2, from: "admins", approvals: [] },
    });
    expect(await s.chat.post("gte_1")).toMatchObject({ status: "posted" });
    expect(s.store.gateEvent("gte_1")?.offer).toEqual(gateOffer(gate));
    expect(s.store.gateEvent("gte_1")?.offer).toMatchObject({
      subjectId: "aps_1",
      subjectDigest: "sha256:1",
      subjectPreviewComplete: true,
      quorum: { required: 2, from: "admins", approvals: [] },
    });
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
