import { afterEach, describe, expect, test } from "bun:test";
import {
  GATE_OUTCOME_TYPE,
  gateOutcomeBody,
  gateOutcomeContent,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  ENCRYPTED_EVENT_TYPE,
  createClient,
  type MatrixEvent,
  type RoomCrypto,
} from "../src/appservice/index.ts";
import {
  SERVICE_TOKEN_MARGIN_MS,
  SWEEP_MAX_BACKOFF,
  createAccounts,
  createBoardChat,
  createBoardRooms,
  createGateAnswers,
  createRoomSender,
  createServiceTokens,
  createSuperpipelineReads,
  gateOffer,
  startGateSweep,
  sweepGates,
  type ResolveResult,
} from "../src/board-chat/index.ts";
import { captureLog, gateBody, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const SERVER = "staging-matrix.example.test";
const ANA = `@ana:${SERVER}`;
const ROOM = `!board:${SERVER}`;
const ROOM_B = `!board-b:${SERVER}`;
const CARD = "$card";
const PROSE = "$prose";
const BOARD = "brd_7c1f";
const BOARD_B = "brd_b2";
const AS_TOKEN = "as-token-for-tests";
const PLANE_URL = "http://accounts.test";
const SP_URL = "http://superpipeline.test";
const CREDENTIAL = {
  id: `svc_${"0a".repeat(10)}`,
  secret: "plane-secret-for-tests",
};
const ANA_PRN = "prn_ana";

interface Sent {
  roomId: string;
  type: string;
  txnId: string;
  content: Record<string, unknown>;
}

/** Sends (a repeated transaction id answered with the first event) and joined members. */
function fakeHomeserver() {
  const sent: Sent[] = [];
  const txns = new Map<string, string>();
  /** Who the homeserver says has joined each room. */
  const joined = { people: [ANA] };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/joined_members"))
      return Response.json({
        joined: Object.fromEntries(joined.people.map((p) => [p, {}])),
      });
    const m =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/(.+)$/.exec(
        url.pathname,
      );
    if (!m)
      return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
    const [, roomId, type, txnId] = m.map((p) => decodeURIComponent(p));
    const key = `${url.searchParams.get("user_id")}|${txnId}`;
    const known = txns.get(key);
    if (known) return Response.json({ event_id: known });
    const eventId = `$sent${sent.length + 1}`;
    txns.set(key, eventId);
    sent.push({
      roomId: roomId as string,
      type: type as string,
      txnId: txnId as string,
      content: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ event_id: eventId });
  }) as typeof globalThis.fetch;
  return { fetch, sent, joined };
}

/** The organization plane: service tokens (numbered), and Ana. */
function fakePlane() {
  const calls: Array<{ path: string; body: unknown; auth: string | null }> = [];
  const state = { tokenStatus: 200, expiresIn: 300, issued: 0 };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (path === "/api/token/service") {
      if (state.tokenStatus !== 200)
        return Response.json(
          { error: "refused" },
          { status: state.tokenStatus },
        );
      return Response.json({
        access_token: `svc-token-${++state.issued}`,
        expires_in: state.expiresIn,
      });
    }
    if (path === `/api/identities/matrix/${ANA}`)
      return Response.json({ principalId: ANA_PRN });
    if (path === `/api/principals/${ANA_PRN}`)
      return Response.json({ id: ANA_PRN, kind: "human", displayName: "Ana" });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    state,
    tokens: () => calls.filter((c) => c.path === "/api/token/service"),
  };
}

type Answer = { status: number; json?: unknown };

/** SuperPipeline's service reads: each board's pending list, each gate's read. */
function fakeSuperpipeline() {
  const reads: Array<{ path: string; auth: string | null }> = [];
  const pending: Record<string, unknown[] | Answer> = {};
  const gates: Record<string, Record<string, unknown> | Answer> = {};
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    reads.push({ path, auth: new Headers(init?.headers).get("authorization") });
    const list = /^\/v1\/boards\/([^/]+)\/gates\/pending$/.exec(path);
    if (list) {
      const p = pending[list[1] as string];
      if (p === undefined)
        return Response.json({ error: "board not found" }, { status: 404 });
      if (Array.isArray(p)) return Response.json({ gates: p });
      return Response.json(p.json ?? null, { status: p.status });
    }
    const one = /^\/v1\/boards\/([^/]+)\/gates\/([^/]+)$/.exec(path);
    if (one) {
      const g = gates[one[2] as string];
      if (g === undefined)
        return Response.json(
          { error: { ok: false, code: "GATE_NOT_FOUND" } },
          { status: 404 },
        );
      if ("status" in g && typeof g.status === "number") {
        const a = g as Answer;
        return Response.json(a.json ?? null, { status: a.status });
      }
      return Response.json({ gate: g });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    reads,
    pending,
    gates,
    gateReads: () => reads.filter((r) => !r.path.endsWith("/pending")),
  };
}

/** Encryption without a machine, as board-chat.test.ts's. */
function fakeCrypto() {
  const encrypted: Array<{ eventType: string; content: unknown }> = [];
  const crypto: RoomCrypto = {
    async encrypt(_roomId, _members, eventType, content) {
      encrypted.push({ eventType, content });
      return {
        algorithm: "m.megolm.v1.aes-sha2",
        ciphertext: JSON.stringify({ type: eventType, content }),
      };
    },
    async decrypt() {
      return null;
    },
  };
  return { crypto, encrypted };
}

const GATE = gateBody({ gateId: "gte_1" }) as unknown as GatePendingDelivery;

function resolved(over: Record<string, unknown> = {}) {
  return {
    id: "gte_1",
    status: "resolved",
    decision: "approve",
    decidedBy: ANA_PRN,
    ...over,
  };
}

function setup({
  plaintextRooms = true,
  crypto = null,
  resolve = async () => ({ ok: true }),
}: {
  plaintextRooms?: boolean;
  crypto?: RoomCrypto | null;
  resolve?: () => Promise<ResolveResult>;
} = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const { store } = t;
  const hs = fakeHomeserver();
  const plane = fakePlane();
  const sp = fakeSuperpipeline();
  const { log, lines } = captureLog();
  const client = createClient({
    homeserverUrl: "http://homeserver.test",
    serverName: SERVER,
    asToken: AS_TOKEN,
    fetch: hs.fetch,
  });
  const rooms = createBoardRooms({
    store,
    client,
    serverName: SERVER,
    encryptNewRooms: !plaintextRooms,
    log,
  });
  const sender = createRoomSender({ store, client, crypto, plaintextRooms });
  const accounts = createAccounts({
    url: PLANE_URL,
    credential: CREDENTIAL,
    fetch: plane.fetch,
  });
  const answers = createGateAnswers({
    store,
    client: sender,
    speaker: rooms.speaker,
    accounts,
    resolveGate: resolve,
    log,
  });
  const chat = createBoardChat({
    store,
    sender,
    rooms,
    crypto,
    answers,
    log,
  });
  const tokens = createServiceTokens({ accounts, audience: SP_URL });
  const deps = {
    store,
    board: createSuperpipelineReads({
      baseUrl: SP_URL,
      tokens,
      fetch: sp.fetch,
    }),
    chat,
    labelFor: (id: string) => accounts.principalLabel(id),
    log,
  };
  for (const [boardId, roomId] of [
    [BOARD, ROOM],
    [BOARD_B, ROOM_B],
  ] as const) {
    store.upsertBoard({
      boardId,
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [ANA],
    });
    store.recordBoardRoom(
      boardId,
      roomId,
      `superexchange_board_${boardId}`,
      !plaintextRooms,
    );
    store.recordMembership(roomId, ANA, "join");
  }

  /** A gate delivered and posted into its board's room. */
  function posted(gateId = "gte_1", boardId = BOARD, roomId = ROOM) {
    const body = gateBody({ gateId, boardId });
    store.recordGateDelivery(gateId, boardId, body);
    store.claimGateEvent(
      gateId,
      boardId,
      roomId,
      gateOffer(body as unknown as GatePendingDelivery),
    );
    store.recordGateProse(gateId, PROSE);
    store.recordGatePosted(gateId, CARD);
  }

  return {
    store,
    hs,
    plane,
    sp,
    chat,
    lines,
    posted,
    tokens,
    sweep: async () => {
      const r = await sweepGates(deps);
      await chat.idle();
      return r;
    },
    deps,
    /** The receipts sent, as event types. */
    receipts: () =>
      hs.sent.filter((e) => e.txnId.includes(".outcome.")).map((e) => e.type),
  };
}

function answer(): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: ROOM,
    sender: ANA,
    event_id: "$answer1",
    content: {
      msgtype: "m.text",
      body: "Approved",
      schema_version: 1,
      suite_event_type: "dev.superpipeline.gate.decision.v1",
      gate_id: "gte_1",
      option_id: "approve",
      comment: null,
      "m.relates_to": { rel_type: "m.reference", event_id: CARD },
    },
  };
}

describe("a gate decided elsewhere", () => {
  test("decided on the web: one receipt, treaty's, at the card, naming the decider", async () => {
    const s = setup();
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();

    const r = await s.sweep();
    expect(r).toMatchObject({ boards: 2, checked: 0, settled: 1 });

    const decided = { decision: "approve", decidedBy: "Ana", chosen: null };
    expect(s.hs.sent).toEqual([
      {
        roomId: ROOM,
        type: "m.room.message",
        txnId: "superexchange.gate.gte_1.outcome.prose",
        content: { msgtype: "m.text", body: gateOutcomeBody(decided) },
      },
      {
        roomId: ROOM,
        type: GATE_OUTCOME_TYPE,
        txnId: "superexchange.gate.gte_1.outcome.card",
        content: gateOutcomeContent({
          ...decided,
          gateId: "gte_1",
          boardId: BOARD,
          gateEventId: CARD,
        }),
      },
    ]);
    expect(s.store.gateEvent("gte_1")).toMatchObject({
      settledDecision: "approve",
      outcomePostedAt: expect.any(String),
      outcomeClaimedAt: expect.any(String),
    });

    // A second pass finds it settled: nothing more is read or said.
    const reads = s.sp.gateReads().length;
    expect((await s.sweep()).settled).toBe(0);
    expect(s.sp.gateReads().length).toBe(reads);
    expect(s.hs.sent.length).toBe(2);
  });

  test("answered in chat, then swept: still one receipt", async () => {
    const s = setup();
    s.posted();
    await s.chat.onEvents("t", [answer()]);
    await s.chat.idle();
    expect(s.receipts()).toEqual(["m.room.message", GATE_OUTCOME_TYPE]);

    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    await s.sweep();
    expect(s.receipts()).toEqual(["m.room.message", GATE_OUTCOME_TYPE]);
    expect(s.store.gateEvent("gte_1")?.settledAt).toBeNull();
  });

  test("an answer the board refused as already decided: the sweep posts the one receipt", async () => {
    const s = setup({
      resolve: async () => ({ ok: false, code: "GATE_NOT_PENDING" }),
    });
    s.posted();
    await s.chat.onEvents("t", [answer()]);
    await s.chat.idle();
    expect(s.receipts()).toEqual([]);

    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved({ decision: "reject" });
    expect((await s.sweep()).settled).toBe(1);
    await s.sweep();
    expect(s.receipts()).toEqual(["m.room.message", GATE_OUTCOME_TYPE]);
  });

  test("settled by the sweep, a later answer in chat is told it was decided, and the board is not asked", async () => {
    let asked = 0;
    const s = setup({
      resolve: async () => {
        asked++;
        return { ok: true };
      },
    });
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    await s.sweep();
    await s.chat.onEvents("t", [answer()]);
    await s.chat.idle();
    expect(asked).toBe(0);
    expect(s.receipts()).toEqual(["m.room.message", GATE_OUTCOME_TYPE]);
  });

  test("not resolved, or not readable, is not a decision: nothing is said", async () => {
    const s = setup();
    s.posted("gte_1");
    s.posted("gte_2");
    s.posted("gte_3");
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    // Pending on the board, though not listed (its card archived), with a quorum approval
    // recorded: a decision on a gate that has not passed is not its outcome.
    s.sp.gates.gte_1 = resolved({ status: "pending", decision: "approve" });
    // gte_2: the board does not know it (404). gte_3: resolved without a decision.
    s.sp.gates.gte_3 = resolved({ id: "gte_3", decision: null });
    const r = await s.sweep();
    expect(r).toMatchObject({ settled: 0, failedGates: 1 });
    expect(s.hs.sent).toEqual([]);
    expect(s.lines.join("\n")).toContain(
      'the sweep could not settle gate "gte_2" on brd_7c1f (SuperPipeline answered 404 (GATE_NOT_FOUND))',
    );
  });

  test("a held approval pulled back reads as changes requested, by who pulled it back", async () => {
    const s = setup();
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved({
      decidedBy: "prn_someone_else",
      pulledBack: { by: ANA_PRN, at: "t", comment: "wait" },
    });
    await s.sweep();
    expect(s.hs.sent[0]?.content.body).toBe(
      gateOutcomeBody({
        decision: "request_changes",
        decidedBy: "Ana",
        chosen: null,
      }),
    );
  });

  test("a decider who is not a principal id is not looked up, and is not named", async () => {
    const s = setup();
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved({ decidedBy: "usr_dev" });
    await s.sweep();
    expect(
      s.plane.calls.some((c) => c.path.startsWith("/api/principals")),
    ).toBe(false);
    expect(s.hs.sent[0]?.content.body).toBe(
      gateOutcomeBody({ decision: "approve", decidedBy: null, chosen: null }),
    );
  });

  test("decided before it was posted: it is never posted, by the sweep, a join or a redelivery", async () => {
    const s = setup();
    s.store.recordMembership(ROOM, ANA, "leave");
    s.store.recordGateDelivery("gte_1", BOARD, GATE);
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    expect((await s.sweep()).settled).toBe(1);
    expect(s.store.unpostedGates()).toEqual([]);

    s.store.recordMembership(ROOM, ANA, "join");
    expect(await s.chat.post("gte_1")).toEqual({
      status: "skipped",
      reason: "settled",
    });
    expect(s.hs.sent).toEqual([]);
  });

  test("in an encrypted room the receipt is encrypted", async () => {
    const c = fakeCrypto();
    const s = setup({ plaintextRooms: false, crypto: c.crypto });
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    await s.sweep();
    expect(s.hs.sent.map((e) => e.type)).toEqual([
      ENCRYPTED_EVENT_TYPE,
      ENCRYPTED_EVENT_TYPE,
    ]);
    expect(c.encrypted.map((e) => e.eventType)).toEqual([
      "m.room.message",
      GATE_OUTCOME_TYPE,
    ]);
  });

  test("a room that may not be spoken in is not claimed, so nothing is lost", async () => {
    // An encrypted room, and the speaker has no keys: it is not spoken in.
    const s = setup({ plaintextRooms: false });
    s.posted();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    expect((await s.sweep()).settled).toBe(0);
    expect(s.hs.sent).toEqual([]);
    expect(s.store.gateEvent("gte_1")?.outcomePostedAt).toBeNull();
  });
});

describe("a gate that never arrived", () => {
  test("is recorded as if delivered and posted once; another board's entry is not", async () => {
    const s = setup();
    s.sp.pending[BOARD] = [
      gateBody({ gateId: "gte_9" }),
      gateBody({ gateId: "gte_x", boardId: BOARD_B }),
      { event: "something.else" },
    ];
    s.sp.pending[BOARD_B] = [];
    const r = await s.sweep();
    expect(r).toMatchObject({ checked: 1, projected: 1, unreadable: 2 });
    expect(s.store.gateDelivery("gte_9")?.body).toEqual(
      gateBody({ gateId: "gte_9" }),
    );
    expect(s.store.gateDelivery("gte_x")).toBeNull();
    expect(s.hs.sent.map((e) => e.txnId)).toEqual([
      "superexchange.gate.gte_9.prose",
      "superexchange.gate.gte_9.card",
    ]);

    // The next pass finds it posted and pending: nothing more is read or said.
    s.sp.gates.gte_9 = resolved({ id: "gte_9" });
    expect((await s.sweep()).projected).toBe(0);
    expect(s.hs.sent.length).toBe(2);
    expect(s.sp.gateReads()).toEqual([]);
  });

  test("a delivered gate not yet posted is offered again, and its hold logged once", async () => {
    const s = setup();
    s.store.recordMembership(ROOM, ANA, "invite");
    s.hs.joined.people = [];
    s.store.recordGateDelivery("gte_1", BOARD, GATE);
    s.sp.pending[BOARD] = [GATE];
    s.sp.pending[BOARD_B] = [];
    await s.sweep();
    await s.sweep();
    expect(s.lines.filter((l) => l.includes("held until")).length).toBe(1);
    expect(s.hs.sent).toEqual([]);
    // Joined between passes (missed by the transaction stream): the next pass posts it.
    s.store.recordMembership(ROOM, ANA, "join");
    const r = await s.sweep();
    expect(r.projected).toBe(0);
    expect(s.hs.sent.map((e) => e.txnId)).toEqual([
      "superexchange.gate.gte_1.prose",
      "superexchange.gate.gte_1.card",
    ]);
  });
});

describe("a board that cannot be read", () => {
  test("404 and 403 are logged, settle nothing, and the other boards are still swept", async () => {
    const s = setup();
    s.posted("gte_1", BOARD, ROOM);
    s.posted("gte_b", BOARD_B, ROOM_B);
    s.sp.gates.gte_1 = resolved();
    s.sp.gates.gte_b = resolved({ id: "gte_b" });
    // brd_7c1f is unknown to SuperPipeline (404); brd_b2 answers.
    s.sp.pending[BOARD_B] = [];
    let r = await s.sweep();
    expect(r).toMatchObject({ boards: 2, failedBoards: 1, settled: 1 });
    expect(s.hs.sent.every((e) => e.roomId === ROOM_B)).toBe(true);
    expect(s.store.gateEvent("gte_1")?.outcomePostedAt).toBeNull();
    expect(s.lines).toContain(
      "board-chat: the sweep could not read the pending gates of brd_7c1f (SuperPipeline answered 404 (HTTP_404))",
    );

    s.sp.pending[BOARD] = {
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "no gates:read" } },
    };
    r = await s.sweep();
    expect(r).toMatchObject({ failedBoards: 1, settled: 0 });
    expect(s.lines.join("\n")).toContain(
      "(SuperPipeline answered 403 (FORBIDDEN))",
    );
    expect(s.store.gateEvent("gte_1")?.outcomePostedAt).toBeNull();
  });

  test("a board out of reach is logged as unreachable, without the request's error", async () => {
    const plane = fakePlane();
    const { log, lines } = captureLog();
    const reads = createSuperpipelineReads({
      baseUrl: SP_URL,
      tokens: createServiceTokens({
        accounts: createAccounts({
          url: PLANE_URL,
          credential: CREDENTIAL,
          fetch: plane.fetch,
        }),
        audience: SP_URL,
      }),
      fetch: (async (input: URL | RequestInfo) => {
        throw new TypeError(`connect ECONNREFUSED ${String(input)}`);
      }) as unknown as typeof globalThis.fetch,
    });
    const t = tempStore();
    cleanups.push(t.cleanup);
    t.store.upsertBoard({
      boardId: BOARD,
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [],
    });
    const r = await sweepGates({
      store: t.store,
      board: reads,
      chat: {
        post: async () => ({ status: "already" }),
        settle: async () => "unknown",
      },
      labelFor: async () => null,
      log,
    });
    expect(r.failedBoards).toBe(1);
    expect(lines[0]).toBe(
      "board-chat: the sweep could not read the pending gates of brd_7c1f (SuperPipeline answered nothing (unreachable))",
    );
    expect(lines.join("\n")).not.toContain(SP_URL);
  });

  test("a disabled board is not asked", async () => {
    const s = setup();
    s.store.disableBoard(BOARD_B);
    s.sp.pending[BOARD] = [];
    const r = await s.sweep();
    expect(r.boards).toBe(1);
    expect(s.sp.reads.map((x) => x.path)).toEqual([
      "/v1/boards/brd_7c1f/gates/pending",
    ]);
  });
});

describe("the service token", () => {
  test("is asked for SuperPipeline with the service credential, sent as a bearer, and held", async () => {
    const s = setup();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    await s.sweep();
    await s.sweep();
    expect(s.plane.tokens()).toEqual([
      {
        path: "/api/token/service",
        body: { audience: SP_URL },
        auth: `Bearer ${CREDENTIAL.id}:${CREDENTIAL.secret}`,
      },
    ]);
    expect(new Set(s.sp.reads.map((r) => r.auth))).toEqual(
      new Set(["Bearer svc-token-1"]),
    );
  });

  test("is replaced shortly before it expires", async () => {
    const plane = fakePlane();
    let now = 0;
    const tokens = createServiceTokens({
      accounts: createAccounts({
        url: PLANE_URL,
        credential: CREDENTIAL,
        fetch: plane.fetch,
      }),
      audience: SP_URL,
      now: () => now,
    });
    expect(await tokens.get()).toBe("svc-token-1");
    now = 300_000 - SERVICE_TOKEN_MARGIN_MS - 1;
    expect(await tokens.get()).toBe("svc-token-1");
    now = 300_000 - SERVICE_TOKEN_MARGIN_MS;
    expect(await tokens.get()).toBe("svc-token-2");
    // Two callers at once share one request.
    tokens.invalidate();
    const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
    expect([a, b]).toEqual(["svc-token-3", "svc-token-3"]);
    expect(plane.tokens().length).toBe(3);
  });

  test("a short-lived token is replaced at half its life", async () => {
    const plane = fakePlane();
    plane.state.expiresIn = 60;
    let now = 0;
    const tokens = createServiceTokens({
      accounts: createAccounts({
        url: PLANE_URL,
        credential: CREDENTIAL,
        fetch: plane.fetch,
      }),
      audience: SP_URL,
      now: () => now,
    });
    await tokens.get();
    now = 29_999;
    expect(await tokens.get()).toBe("svc-token-1");
    now = 30_000;
    expect(await tokens.get()).toBe("svc-token-2");
  });

  test("a 401 drops it, so the next pass asks for a new one", async () => {
    const s = setup();
    s.sp.pending[BOARD] = {
      status: 401,
      json: { error: { code: "UNAUTHORIZED" } },
    };
    s.sp.pending[BOARD_B] = [];
    await s.sweep();
    s.sp.pending[BOARD] = [];
    await s.sweep();
    expect(s.plane.tokens().length).toBe(2);
    expect(s.sp.reads.at(-1)?.auth).toBe("Bearer svc-token-2");
  });

  test("a token the plane refuses fails every board, and holds nothing", async () => {
    const s = setup();
    s.plane.state.tokenStatus = 403;
    const r = await s.sweep();
    expect(r).toMatchObject({ boards: 2, failedBoards: 2 });
    expect(s.sp.reads).toEqual([]);
    expect(s.lines.join("\n")).toContain(
      "the organization plane answered 403 (refused)",
    );
    s.plane.state.tokenStatus = 200;
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    expect((await s.sweep()).failedBoards).toBe(0);
  });
});

describe("the sweeper", () => {
  test("sweeps at once, then every interval, backing off while every board fails", async () => {
    const s = setup();
    const delays: number[] = [];
    const next: Array<() => void> = [];
    let cancelled: unknown = null;
    const sweeper = startGateSweep(s.deps, {
      intervalMs: 60_000,
      schedule: (run, ms) => {
        delays.push(ms);
        next.push(run);
        return `handle-${delays.length}`;
      },
      cancel: (h) => {
        cancelled = h;
      },
    });
    const waitFor = async (n: number) => {
      for (let i = 0; i < 5000 && delays.length < n; i++) await Bun.sleep(1);
    };
    // At boot: both boards unknown to SuperPipeline, so the pass failed.
    await waitFor(1);
    expect(s.sp.reads.length).toBe(2);
    for (let i = 2; i <= 5; i++) {
      next[i - 2]?.();
      await waitFor(i);
    }
    expect(delays).toEqual([
      120_000,
      240_000,
      60_000 * SWEEP_MAX_BACKOFF,
      60_000 * SWEEP_MAX_BACKOFF,
      60_000 * SWEEP_MAX_BACKOFF,
    ]);
    // One board answers: back to the interval.
    s.sp.pending[BOARD] = [];
    next[4]?.();
    await waitFor(6);
    expect(delays[5]).toBe(60_000);
    sweeper.stop();
    expect(cancelled).toBe("handle-6");
  });

  test("nothing happening logs nothing", async () => {
    const s = setup();
    s.sp.pending[BOARD] = [];
    s.sp.pending[BOARD_B] = [];
    await s.sweep();
    expect(s.lines).toEqual([]);
  });
});

describe("no secret reaches a log or the room", () => {
  test("the credential, the token and the URLs appear in no log line or message", async () => {
    const s = setup();
    s.posted();
    s.sp.pending[BOARD] = {
      status: 401,
      json: { error: { code: "UNAUTHORIZED" } },
    };
    s.sp.pending[BOARD_B] = [];
    s.sp.gates.gte_1 = resolved();
    await s.sweep();
    s.sp.pending[BOARD] = [];
    await s.sweep();
    s.plane.state.tokenStatus = 500;
    s.tokens.invalidate();
    await s.sweep();
    const text = [...s.lines, ...s.hs.sent.map((e) => JSON.stringify(e))].join(
      "\n",
    );
    for (const secret of [
      CREDENTIAL.secret,
      "svc-token-",
      PLANE_URL,
      SP_URL,
      ANA_PRN,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
