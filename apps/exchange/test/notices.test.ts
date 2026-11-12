import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHECKS_WAITING_TYPE,
  CHECK_FAILED_TYPE,
  CHECK_OVERRIDDEN_TYPE,
  CHECK_OVERRIDE_V2_SUITE_TYPE,
  DECISION_ESCALATED_SUITE_TYPE,
  DECISION_PULLED_BACK_TYPE,
  DECISION_RELEASED_TYPE,
  DECISION_REMINDED_SUITE_TYPE,
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_EVENT_TYPE,
  GATE_PROGRESS_TYPE,
  GATE_PULL_BACK_V2_SUITE_TYPE,
  checkFailedBody,
  checkOverriddenBody,
  decisionNoticeContent,
  gateProgressBody,
  pulledBackBody,
  releasedBody,
  type AttentionPendingDelivery,
  type DecisionTimeoutDelivery,
  type DeliveryPendingDelivery,
  type ElicitationPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import { createClient, type MatrixEvent } from "../src/appservice/index.ts";
import {
  CHECK_FAILED_V1,
  CHECK_OVERRIDDEN_V1,
  CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT,
  DECISION_ESCALATED_V1,
  DECISION_PULLED_BACK_V1,
  DECISION_RELEASED_V1,
  DECISION_REMINDED_V1,
  GATE_APPROVAL_RECORDED_V1,
  IDENTITY_UNAVAILABLE_TEXT,
  MOVED_BELOW_TEXT,
  PULL_BACK_COMMENT_REQUIRED_TEXT,
  SuperpipelineError,
  checkOverrideRefusalText,
  createAccounts,
  createBoardChat,
  createBoardRooms,
  createCheckOverrides,
  createEscalationRecipients,
  createGateAnswers,
  createPullBacks,
  createQuestionAnswers,
  createRoomSender,
  answerQuestionAtSuperpipeline,
  intakeAttention,
  intakeFollowup,
  intakeGate,
  intakeNotice,
  intakeQuestion,
  noticeTxnId,
  overrideCheckAtSuperpipeline,
  pullBackAtSuperpipeline,
  pullBackRefusalText,
  resolveGateAtSuperpipeline,
} from "../src/board-chat/index.ts";
import { createRelayHandler } from "../src/routes/relay.ts";
import {
  AGENT,
  ANA,
  AS_TOKEN,
  CREDENTIAL,
  PLANE_URL,
  SERVER,
  SPEAKER,
  SP_URL,
  STRANGER,
  fakeBoard,
  fakeHomeserver,
  fakePlane,
  jwt,
  relayRequest,
} from "./board-fakes.ts";
import { captureLog, gateBody, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ROOM = `!board:${SERVER}`;
const OTHER_ROOM = `!other:${SERVER}`;
const BOARD = "brd_7c1f";
const CARD = "crd_8a40";
const BEA = `@bea:${SERVER}`;
const CAL = `@cal:${SERVER}`;
const T = "2026-11-12T10:00:00.000Z";

// ── fixtures, as SuperPipeline publishes them (the hub's) ──────────────────

function timeout(
  over: Partial<DecisionTimeoutDelivery> = {},
): DecisionTimeoutDelivery {
  return {
    event: "decision.reminded",
    boardId: BOARD,
    boardName: "Release board",
    cardId: CARD,
    cardTitle: "Ship the release",
    stageKey: "review",
    stageName: "Review",
    decisionKind: "gate",
    decisionId: "gte_1",
    waitingSince: "2026-11-12T07:00:00.000Z",
    remindedAt: T,
    ts: T,
    ...over,
  };
}

function escalation(over: Partial<DecisionTimeoutDelivery> = {}) {
  const { remindedAt: _r, ...base } = timeout();
  return {
    ...base,
    event: "decision.escalated",
    escalatedAt: "2026-11-12T11:00:00.000Z",
    ts: "2026-11-12T11:00:00.000Z",
    ...over,
  } as DecisionTimeoutDelivery;
}

const QUORUM = { required: 2, from: "deciders", approvals: [] };

function approval(principalId = "prn_ana", earlier: string[] = []) {
  return {
    event: "gate.approval_recorded",
    boardId: BOARD,
    cardId: CARD,
    gateId: "gte_1",
    approval: { principalId, at: T },
    quorum: {
      required: 2,
      from: "deciders",
      approvals: [...earlier, principalId].map((p) => ({
        principalId: p,
        at: T,
      })),
    },
  };
}

const released = (over: Record<string, unknown> = {}) => ({
  event: "decision.released",
  boardId: BOARD,
  cardId: CARD,
  gateId: "gte_1",
  decision: "approve",
  releaseAt: T,
  releasedAt: T,
  outcome: "released",
  ...over,
});

const pulledBack = (over: Record<string, unknown> = {}) => ({
  event: "decision.pulled_back",
  boardId: BOARD,
  cardId: CARD,
  gateId: "gte_1",
  pulledBackBy: "prn_ana",
  at: T,
  comment: "wrong image",
  ...over,
});

const checkFailed = (over: Record<string, unknown> = {}) => ({
  event: "check.failed",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "Ship the release",
  arrivalId: "arr_1",
  stageKey: "review",
  check: { name: "build", provider: "ci", status: "failed" },
  returnedTo: "build",
  ...over,
});

const checkOverridden = (over: Record<string, unknown> = {}) => ({
  event: "check.overridden",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "Ship the release",
  arrivalId: "arr_1",
  stageKey: "review",
  check: { name: "build", provider: "ci", status: "overridden" },
  by: "prn_ana",
  comment: "flaky runner",
  at: T,
  ...over,
});

function questionBody(): ElicitationPendingDelivery {
  return {
    event: "elicitation.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: CARD,
    cardTitle: "Ship the release",
    elicitationId: "elc_1",
    runId: "run_12",
    stageKey: "review",
    agentId: "agt_31d0",
    question: "May I run the tests?",
    options: [
      { id: "run_them", label: "Run the tests", meaning: "choose" },
      { id: "skip", label: "Skip them", meaning: "choose" },
    ],
  } as ElicitationPendingDelivery;
}

function followupBody(): DeliveryPendingDelivery {
  return {
    event: "delivery.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: CARD,
    cardTitle: "Ship the release",
    gateId: "gate_8f3a",
    stageKey: "approve",
    options: [
      {
        id: "record_live_url",
        label: "Record the live link",
        meaning: "defer",
        needsComment: false,
        input: {
          kind: "url",
          label: "Live link",
          required: true,
          maxLength: 2000,
        },
      },
    ],
    ts: T,
  } as DeliveryPendingDelivery;
}

function attentionBody(): AttentionPendingDelivery {
  return {
    event: "attention.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: CARD,
    cardTitle: "Ship the release",
    stageKey: "build",
    stageName: "Build",
    waitId: "wait_0123456789abcdef",
    reason: "blocked",
    detail: "the staging database is down",
    summary: "Staging DB down",
    failureCount: null,
    earlierStages: [],
    options: [
      {
        id: "archive",
        label: "Archive",
        meaning: "reject",
        needsComment: false,
      },
    ],
    ts: T,
  } as AttentionPendingDelivery;
}

// ── the harness ─────────────────────────────────────────────────────────────

interface Admin {
  id: string;
  role: string;
  suspended?: boolean;
  mxid?: string;
}

function setup({
  clock = null as { now: Date } | null,
  org = "org_1",
  admins = [
    { id: "prn_bea", role: "owner", mxid: BEA },
    { id: "prn_cal", role: "admin", mxid: CAL },
  ] as Admin[],
} = {}) {
  const t = tempStore(clock ? () => clock.now : undefined);
  cleanups.push(t.cleanup);
  const store = t.store;
  const hs = fakeHomeserver();
  const plane = fakePlane();
  const board = fakeBoard();
  const { log, lines } = captureLog();
  const invites: string[] = [];
  /** Every send asked of the homeserver, by event type: a repeat the homeserver dedupes counts too. */
  const attempts: string[] = [];
  const state = {
    failNotices: false,
    inviteFails: false,
    adminsDown: false,
    checks: {
      stageKey: "review",
      status: "open",
      checks: [{ name: "build", provider: "ci", status: "pending" }],
    } as unknown,
    checksError: null as SuperpipelineError | null,
    pending: {} as Record<string, unknown[] | Error>,
    admins,
  };
  const hsFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const send = /\/send\/([^/]+)\//.exec(path);
    if (send) attempts.push(send[1] as string);
    if (path.endsWith("/invite")) {
      if (state.inviteFails)
        return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
      invites.push(
        (JSON.parse(String(init?.body)) as { user_id: string }).user_id,
      );
      return Response.json({});
    }
    if (
      state.failNotices &&
      String(init?.body ?? "").includes(DECISION_ESCALATED_SUITE_TYPE)
    )
      return Response.json({ errcode: "M_UNKNOWN" }, { status: 500 });
    return hs.fetch(input, init);
  }) as typeof fetch;
  const planeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (
      path === "/api/principals" &&
      url.searchParams.get("kind") === "human"
    ) {
      if (state.adminsDown)
        return Response.json({ error: "x" }, { status: 503 });
      return Response.json([
        { id: "prn_ana", kind: "human", role: "member", suspended: false },
        ...state.admins.map((a) => ({
          id: a.id,
          kind: "human",
          role: a.role,
          suspended: a.suspended ?? false,
        })),
      ]);
    }
    const ids = /^\/api\/principals\/([^/]+)\/identities$/.exec(path);
    if (ids) {
      const a = state.admins.find((x) => x.id === ids[1]);
      return Response.json(
        a?.mxid ? [{ system: "matrix", externalId: a.mxid }] : [],
      );
    }
    return plane.fetch(input, init);
  }) as typeof fetch;
  const client = createClient({
    homeserverUrl: "http://homeserver.test",
    serverName: SERVER,
    asToken: AS_TOKEN,
    fetch: hsFetch,
  });
  const rooms = createBoardRooms({
    store,
    client,
    serverName: SERVER,
    encryptNewRooms: false,
    log,
  });
  const sender = createRoomSender({
    store,
    client,
    crypto: null,
    plaintextRooms: true,
  });
  const accounts = createAccounts({
    url: PLANE_URL,
    credential: CREDENTIAL,
    fetch: planeFetch,
  });
  const mint = (subject: { principalId: string; senderMxid: string }) =>
    accounts.assert({ ...subject, audience: SP_URL });
  const sp = { baseUrl: SP_URL, mint, fetch: board.fetch };
  const pending = (kind: string) => async () => {
    const p = state.pending[kind];
    if (p instanceof Error) throw p;
    return p ?? [];
  };
  const reads = {
    pendingGates: pending("gate"),
    pendingQuestions: pending("question"),
    pendingFollowups: pending("delivery"),
    pendingAttention: pending("attention"),
    async cardChecks() {
      if (state.checksError) throw state.checksError;
      return state.checks as {
        stageKey: string;
        status: string;
        checks: unknown[];
      };
    },
  };
  const answers = createGateAnswers({
    store,
    client: sender,
    speaker: rooms.speaker,
    accounts,
    resolveGate: (input) => resolveGateAtSuperpipeline(input, sp),
    log,
  });
  const chat = createBoardChat({
    store,
    sender,
    rooms,
    crypto: null,
    answers,
    questions: createQuestionAnswers({
      store,
      client: sender,
      speaker: rooms.speaker,
      accounts,
      answerQuestion: (input) => answerQuestionAtSuperpipeline(input, sp),
      log,
    }),
    pullBacks: createPullBacks({
      store,
      client: sender,
      speaker: rooms.speaker,
      accounts,
      pullBack: (input) => pullBackAtSuperpipeline(input, sp),
      log,
    }),
    overrides: createCheckOverrides({
      store,
      client: sender,
      speaker: rooms.speaker,
      accounts,
      override: (input) => overrideCheckAtSuperpipeline(input, sp),
      log,
    }),
    notices: {
      invite: (roomId, userId) => client.invite(SPEAKER, roomId, userId),
      recipients: createEscalationRecipients({
        tokens: { get: async () => jwt({ org }) },
        accounts,
        log,
      }),
      labelFor: (id) => accounts.principalLabel(id),
      reads,
    },
    log,
  });
  for (const [boardId, roomId] of [
    [BOARD, ROOM],
    ["brd_other", OTHER_ROOM],
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
      false,
    );
    store.recordMembership(roomId, SPEAKER, "join");
    store.recordMembership(roomId, ANA, "join");
  }

  /** Deliver and post a gate; its prose and card events. */
  async function gate(over: Record<string, unknown> = {}) {
    intakeGate(store, gateBody(over));
    const out = await chat.post(String(over.gateId ?? "gte_1"));
    if (out.status !== "posted")
      throw new Error(`gate not posted: ${out.status}`);
    return { prose: out.proseEventId, card: out.cardEventId };
  }
  /** Record a notice as the relay would, and post it. */
  async function notice(type: string, body: unknown) {
    const intake = intakeNotice(store, type, body);
    if (intake.status !== "accepted") return intake;
    return chat.postNotice(intake.noticeId);
  }
  async function deliver(...events: MatrixEvent[]) {
    await chat.onEvents("txn", events);
    await chat.idle();
  }
  const said = () =>
    hs.sent
      .filter(
        (e) =>
          e.type === "m.room.message" &&
          e.content.suite_event_type === undefined,
      )
      .map((e) => e.content.body);
  const ofType = (type: string) => hs.sent.filter((e) => e.type === type);
  const marked = (type: string) =>
    hs.sent.filter((e) => e.content.suite_event_type === type);
  return {
    store,
    hs,
    plane,
    board,
    chat,
    state,
    invites,
    attempts,
    lines,
    gate,
    notice,
    deliver,
    said,
    ofType,
    marked,
  };
}

const replyTo = (content: Record<string, unknown>) =>
  (
    content["m.relates_to"] as
      | { "m.in_reply_to"?: { event_id?: string } }
      | undefined
  )?.["m.in_reply_to"]?.event_id ?? null;

const join = (userId: string, roomId = ROOM): MatrixEvent => ({
  type: "m.room.member",
  room_id: roomId,
  state_key: userId,
  sender: userId,
  content: { membership: "join" },
});

// ── the relay ───────────────────────────────────────────────────────────────

describe("the relay's board-room notices", () => {
  test("are the catalogue's CloudEvents types", () => {
    expect([
      DECISION_REMINDED_V1,
      DECISION_ESCALATED_V1,
      GATE_APPROVAL_RECORDED_V1,
      DECISION_RELEASED_V1,
      DECISION_PULLED_BACK_V1,
      CHECK_FAILED_V1,
      CHECK_OVERRIDDEN_V1,
    ]).toEqual([
      "com.superjackfruit.superpipeline.decision.reminded.v1",
      "com.superjackfruit.superpipeline.decision.escalated.v1",
      "com.superjackfruit.superpipeline.gate.approval_recorded.v1",
      "com.superjackfruit.superpipeline.decision.released.v1",
      "com.superjackfruit.superpipeline.decision.pulled_back.v1",
      "com.superjackfruit.superpipeline.check.failed.v1",
      "com.superjackfruit.superpipeline.check.overridden.v1",
    ]);
  });

  function relay(s: ReturnType<typeof setup>) {
    const accepted: string[] = [];
    const handle = createRelayHandler({
      secret: "relay-secret-for-tests",
      store: s.store,
      log: () => undefined,
      onNoticeAccepted: (id) => accepted.push(id),
    });
    return { handle, accepted };
  }

  test("each notice for a card posted here is recorded once and handed on, a redelivery too", async () => {
    const s = setup();
    await s.gate({ quorum: QUORUM });
    const r = relay(s);
    const cases: Array<[unknown, string]> = [
      [timeout(), DECISION_REMINDED_V1],
      [escalation(), DECISION_ESCALATED_V1],
      [approval(), GATE_APPROVAL_RECORDED_V1],
      [released(), DECISION_RELEASED_V1],
      [pulledBack(), DECISION_PULLED_BACK_V1],
      [checkFailed(), CHECK_FAILED_V1],
      [checkOverridden(), CHECK_OVERRIDDEN_V1],
    ];
    for (let i = 0; i < 2; i++) {
      for (const [body, type] of cases) {
        const res = await r.handle(await relayRequest(body, type));
        expect(await res.json()).toEqual({ status: "accepted" });
      }
    }
    expect(r.accepted).toHaveLength(14);
    expect(new Set(r.accepted).size).toBe(7);
    expect(s.store.unpostedNotices()).toHaveLength(7);
  });

  test("a body under another notice's type is refused, as is a malformed one", async () => {
    const s = setup();
    await s.gate();
    const r = relay(s);
    for (const [body, type] of [
      [timeout(), DECISION_ESCALATED_V1],
      [escalation(), DECISION_REMINDED_V1],
      [checkFailed(), CHECK_OVERRIDDEN_V1],
      [released(), DECISION_PULLED_BACK_V1],
      [timeout({ decisionKind: "nope" as "gate" }), DECISION_REMINDED_V1],
      [
        {
          ...checkFailed(),
          check: { name: "a/b", provider: "ci", status: "failed" },
        },
        CHECK_FAILED_V1,
      ],
    ] as const) {
      const res = await r.handle(await relayRequest(body, type));
      expect(res.status).toBe(400);
    }
    expect(s.store.unpostedNotices()).toEqual([]);
  });

  test("a type that only names an object's own machinery is not a notice", async () => {
    const s = setup();
    const r = relay(s);
    for (const type of ["constructor", "__proto__", "toString"]) {
      const res = await r.handle(await relayRequest(timeout(), type));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ignored" });
    }
  });

  test("a board not opted in or disabled, a card never posted here, or one already settled: ignored, nothing recorded", async () => {
    const s = setup();
    const r = relay(s);
    const ignored = async (body: unknown, type: string) =>
      (await (
        await r.handle(await relayRequest(body, type))
      ).json()) as unknown;
    expect(
      await ignored(timeout({ boardId: "brd_nobody" }), DECISION_REMINDED_V1),
    ).toEqual({
      status: "ignored",
    });
    // Never posted here: nothing to reply to.
    expect(await ignored(timeout(), DECISION_REMINDED_V1)).toEqual({
      status: "ignored",
    });
    expect(await ignored(approval(), GATE_APPROVAL_RECORDED_V1)).toEqual({
      status: "ignored",
    });
    expect(await ignored(released(), DECISION_RELEASED_V1)).toEqual({
      status: "ignored",
    });
    await s.gate();
    // Another card's gate is not this card's.
    expect(
      await ignored(timeout({ cardId: "crd_other" }), DECISION_REMINDED_V1),
    ).toEqual({
      status: "ignored",
    });
    s.store.claimGateReceipt("gte_1");
    expect(await ignored(timeout(), DECISION_REMINDED_V1)).toEqual({
      status: "ignored",
    });
    expect(await ignored(approval(), GATE_APPROVAL_RECORDED_V1)).toEqual({
      status: "ignored",
    });
    s.store.disableBoard(BOARD);
    expect(await ignored(checkFailed(), CHECK_FAILED_V1)).toEqual({
      status: "ignored",
    });
    expect(s.store.unpostedNotices()).toEqual([]);
    expect(r.accepted).toEqual([]);
  });

  test("a release or a pull-back on a settled gate is said: it follows the held approval's receipt", async () => {
    const s = setup();
    await s.gate();
    s.store.claimGateReceipt("gte_1");
    expect((await s.notice(DECISION_RELEASED_V1, released())).status).toBe(
      "posted",
    );
    expect((await s.notice(DECISION_PULLED_BACK_V1, pulledBack())).status).toBe(
      "posted",
    );
  });
});

// ── reminders ───────────────────────────────────────────────────────────────

describe("a reminder", () => {
  test("is treaty's notice in reply to the gate's prose, once per decision", async () => {
    const s = setup();
    const g = await s.gate();
    const out = await s.notice(DECISION_REMINDED_V1, timeout());
    expect(out.status).toBe("posted");
    const sent = s.marked(DECISION_REMINDED_SUITE_TYPE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toEqual(decisionNoticeContent(timeout(), g.prose));
    expect(replyTo(sent[0]?.content ?? {})).toBe(g.prose);
    // Delivered again: one notice in the room.
    expect(
      intakeNotice(s.store, DECISION_REMINDED_V1, timeout()),
    ).toMatchObject({
      status: "accepted",
      duplicate: true,
    });
    await s.chat.idle();
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.marked(DECISION_REMINDED_SUITE_TYPE)).toHaveLength(1);
  });

  test("replies to a question's, a follow-up's and a waiting card's own message", async () => {
    const s = setup();
    intakeQuestion(s.store, questionBody());
    const q = await s.chat.postQuestion("elc_1");
    intakeFollowup(s.store, followupBody());
    const f = await s.chat.postFollowup("gate_8f3a");
    intakeAttention(s.store, attentionBody());
    const a = await s.chat.postAttention({
      boardId: BOARD,
      cardId: CARD,
      waitId: "wait_0123456789abcdef",
    });
    for (const [kind, id, out] of [
      ["question", "elc_1", q],
      ["delivery", "gate_8f3a", f],
      ["attention", "wait_0123456789abcdef", a],
    ] as const) {
      if (out.status !== "posted") throw new Error(out.status);
      expect(
        (
          await s.notice(
            DECISION_REMINDED_V1,
            timeout({ decisionKind: kind, decisionId: id }),
          )
        ).status,
      ).toBe("posted");
      const last = s.marked(DECISION_REMINDED_SUITE_TYPE).at(-1);
      expect(replyTo(last?.content ?? {})).toBe(out.eventId);
    }
  });

  test("of overdue checks stands alone: there is no card to reply to", async () => {
    const s = setup();
    const out = await s.notice(
      DECISION_REMINDED_V1,
      timeout({ decisionKind: "checks", decisionId: "arr_1" }),
    );
    expect(out.status).toBe("posted");
    const sent = s.marked(DECISION_REMINDED_SUITE_TYPE);
    expect(sent).toHaveLength(1);
    expect(replyTo(sent[0]?.content ?? {})).toBeNull();
  });

  test("on a card settled after it was recorded is dropped, and never posted", async () => {
    const s = setup();
    await s.gate();
    const intake = intakeNotice(s.store, DECISION_REMINDED_V1, timeout());
    if (intake.status !== "accepted") throw new Error("not accepted");
    s.store.claimGateReceipt("gte_1");
    expect(await s.chat.postNotice(intake.noticeId)).toEqual({
      status: "dropped",
      reason: "card settled",
    });
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.marked(DECISION_REMINDED_SUITE_TYPE)).toEqual([]);
  });

  test("a send that fails keeps its claim and is sent again under the same id, once", async () => {
    const s = setup();
    const g = await s.gate();
    s.hs.fail(true);
    const intake = intakeNotice(s.store, DECISION_REMINDED_V1, timeout());
    if (intake.status !== "accepted") throw new Error("not accepted");
    expect(await s.chat.postNotice(intake.noticeId)).toEqual({
      status: "failed",
      step: "send",
    });
    // Claimed with the card it replies to: settling the card now does not unsay it.
    expect(s.store.notice(intake.noticeId)?.replyTo).toBe(g.prose);
    s.hs.fail(false);
    s.chat.retryNotices();
    await s.chat.idle();
    const sent = s.marked(DECISION_REMINDED_SUITE_TYPE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.txnId).toBe(noticeTxnId(intake.noticeId, "prose"));
    expect(s.store.notice(intake.noticeId)?.postedAt).not.toBeNull();
  });

  test("a room that may not be spoken in is not claimed", async () => {
    const s = setup();
    await s.gate();
    s.store.recordBoardRoom("brd_x", "!x:y", "a", false);
    const intake = intakeNotice(s.store, DECISION_REMINDED_V1, timeout());
    if (intake.status !== "accepted") throw new Error("not accepted");
    const sender = createRoomSender({
      store: s.store,
      client: { sendEvent: async () => "$x", joinedMembers: async () => [] },
      crypto: null,
      plaintextRooms: false,
    });
    const chat = createBoardChat({
      store: s.store,
      sender,
      rooms: createBoardRooms({
        store: s.store,
        client: {} as never,
        serverName: SERVER,
        encryptNewRooms: false,
        log: () => undefined,
      }),
      crypto: null,
      log: () => undefined,
    });
    expect(await chat.postNotice(intake.noticeId)).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    expect(s.store.notice(intake.noticeId)?.claimedAt).toBeNull();
  });
});

// ── escalations ─────────────────────────────────────────────────────────────

describe("an escalation", () => {
  test("invites the workspace's owners and admins with a linked Matrix id, then replies to the card", async () => {
    const s = setup({
      admins: [
        { id: "prn_bea", role: "owner", mxid: BEA },
        { id: "prn_cal", role: "admin", mxid: CAL },
        {
          id: "prn_dee",
          role: "admin",
          suspended: true,
          mxid: `@dee:${SERVER}`,
        },
        { id: "prn_eve", role: "admin" },
        { id: "prn_fay", role: "member", mxid: `@fay:${SERVER}` },
      ],
    });
    const g = await s.gate();
    expect((await s.notice(DECISION_ESCALATED_V1, escalation())).status).toBe(
      "posted",
    );
    expect(s.invites).toEqual([BEA, CAL]);
    const sent = s.marked(DECISION_ESCALATED_SUITE_TYPE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toEqual(
      decisionNoticeContent(escalation(), g.prose),
    );
    // Invited, so the room key reaches them with the notice.
    expect(s.store.membershipOf(ROOM, BEA)).toBe("invite");
  });

  test("invites a person to a board once: the next escalation, after they left, does not invite them again", async () => {
    const s = setup();
    await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.store.recordMembership(ROOM, BEA, "leave");
    await s.gate({ gateId: "gte_2" });
    await s.notice(DECISION_ESCALATED_V1, escalation({ decisionId: "gte_2" }));
    expect(s.invites).toEqual([BEA, CAL]);
    expect(s.marked(DECISION_ESCALATED_SUITE_TYPE)).toHaveLength(2);
  });

  test("an invite the homeserver refuses is tried again on the next escalation", async () => {
    const s = setup();
    await s.gate();
    s.state.inviteFails = true;
    expect((await s.notice(DECISION_ESCALATED_V1, escalation())).status).toBe(
      "posted",
    );
    expect(s.invites).toEqual([]);
    s.state.inviteFails = false;
    await s.gate({ gateId: "gte_2" });
    await s.notice(DECISION_ESCALATED_V1, escalation({ decisionId: "gte_2" }));
    expect(s.invites).toEqual([BEA, CAL]);
  });

  test("an admin already in the room counts as invited", async () => {
    const s = setup();
    s.store.recordMembership(ROOM, BEA, "join");
    await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    expect(s.invites).toEqual([CAL]);
    s.store.recordMembership(ROOM, BEA, "leave");
    await s.gate({ gateId: "gte_2" });
    await s.notice(DECISION_ESCALATED_V1, escalation({ decisionId: "gte_2" }));
    expect(s.invites).toEqual([CAL]);
  });

  test("a board outside this service's workspace escalates to nobody, and still says it", async () => {
    const s = setup({ org: "org_elsewhere" });
    await s.gate();
    expect((await s.notice(DECISION_ESCALATED_V1, escalation())).status).toBe(
      "posted",
    );
    expect(s.invites).toEqual([]);
    expect(s.lines.join("\n")).toContain("not in this service's workspace");
  });

  test("an admin directory that cannot be read claims nothing, so the retry escalates", async () => {
    const s = setup();
    await s.gate();
    s.state.adminsDown = true;
    const intake = intakeNotice(s.store, DECISION_ESCALATED_V1, escalation());
    if (intake.status !== "accepted") throw new Error("not accepted");
    expect(await s.chat.postNotice(intake.noticeId)).toEqual({
      status: "failed",
      step: "read",
    });
    expect(s.store.notice(intake.noticeId)?.claimedAt).toBeNull();
    expect(s.marked(DECISION_ESCALATED_SUITE_TYPE)).toEqual([]);
    s.state.adminsDown = false;
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.invites).toEqual([BEA, CAL]);
    expect(s.marked(DECISION_ESCALATED_SUITE_TYPE)).toHaveLength(1);
  });
});

describe("overdue checks escalated", () => {
  const checksEscalation = () =>
    escalation({ decisionKind: "checks", decisionId: "arr_1" });

  test("post a checks.waiting card listing them, and the notice in reply to it", async () => {
    const s = setup();
    expect(
      (await s.notice(DECISION_ESCALATED_V1, checksEscalation())).status,
    ).toBe("posted");
    const card = s.marked(CHECKS_WAITING_TYPE);
    expect(card).toHaveLength(1);
    const cardEvent = s.store.checksWaiting(BOARD, "arr_1")?.eventId;
    expect(cardEvent).toBeTruthy();
    const notice = s.marked(DECISION_ESCALATED_SUITE_TYPE);
    expect(replyTo(notice[0]?.content ?? {})).toBe(cardEvent ?? "");
    expect(s.invites).toEqual([BEA, CAL]);
  });

  test("checks that are over, at another stage, or a read the board refuses: the notice alone", async () => {
    for (const change of [
      (s: ReturnType<typeof setup>) => {
        s.state.checks = { stageKey: "review", status: "passed", checks: [] };
      },
      (s: ReturnType<typeof setup>) => {
        s.state.checks = {
          stageKey: "build",
          status: "open",
          checks: [{ name: "build", provider: "ci", status: "pending" }],
        };
      },
      (s: ReturnType<typeof setup>) => {
        s.state.checksError = new SuperpipelineError(403, "FORBIDDEN");
      },
    ]) {
      const s = setup();
      change(s);
      expect(
        (await s.notice(DECISION_ESCALATED_V1, checksEscalation())).status,
      ).toBe("posted");
      expect(s.marked(CHECKS_WAITING_TYPE)).toEqual([]);
      expect(
        replyTo(s.marked(DECISION_ESCALATED_SUITE_TYPE)[0]?.content ?? {}),
      ).toBeNull();
    }
  });

  test("a board that cannot be reached is tried again before anything is claimed", async () => {
    const s = setup();
    s.state.checksError = new SuperpipelineError(0, "unreachable");
    const intake = intakeNotice(
      s.store,
      DECISION_ESCALATED_V1,
      checksEscalation(),
    );
    if (intake.status !== "accepted") throw new Error("not accepted");
    expect(await s.chat.postNotice(intake.noticeId)).toEqual({
      status: "failed",
      step: "read",
    });
    expect(s.store.notice(intake.noticeId)?.claimedAt).toBeNull();
    s.state.checksError = null;
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.marked(CHECKS_WAITING_TYPE)).toHaveLength(1);
  });
});

describe("an invited admin who joins", () => {
  test("gets the gate card moved below, the old copy told, and the notice again in reply to the new one; an answer to the old card acts on nothing", async () => {
    const clock = { now: new Date(T) };
    const s = setup({ clock });
    const g = await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.state.pending.gate = [gateBody()];
    const before = s.hs.sent.length;
    await s.deliver(join(BEA));
    const after = s.hs.sent.slice(before);
    const gateEvent = s.store.gateEvent("gte_1");
    clock.now = new Date("2026-11-12T12:00:00.000Z");
    // A new prose and a new card, then "moved below" on the old prose, then the notice again.
    expect(after.map((e) => e.type)).toEqual([
      "m.room.message",
      GATE_EVENT_TYPE,
      "m.room.message",
      "m.room.message",
    ]);
    expect(gateEvent?.proseEventId).not.toBe(g.prose);
    expect(after[2]?.content.body).toBe(MOVED_BELOW_TEXT);
    expect(replyTo(after[2]?.content ?? {})).toBe(g.prose);
    expect(replyTo(after[3]?.content ?? {})).toBe(
      gateEvent?.proseEventId ?? "",
    );
    expect(after[3]?.content.suite_event_type).toBe(
      DECISION_ESCALATED_SUITE_TYPE,
    );
    // Once per join: a later join event of the same person re-posts nothing.
    clock.now = new Date("2026-11-12T13:00:00.000Z");
    await s.deliver(join(BEA));
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.hs.sent.length).toBe(before + 4);
    expect(s.attempts.filter((t) => t === GATE_EVENT_TYPE)).toHaveLength(2);
    // Ana answers the old card: it no longer counts.
    await s.deliver({
      type: "m.room.message",
      room_id: ROOM,
      sender: ANA,
      event_id: "$old-answer",
      content: {
        msgtype: "m.text",
        body: "Approve",
        suite_event_type: GATE_DECISION_V2_SUITE_TYPE,
        schema_version: 1,
        gate_id: "gte_1",
        option_id: "approve",
        "m.relates_to": { rel_type: "m.reference", event_id: g.prose },
      },
    });
    expect(s.board.calls).toEqual([]);
  });

  test("a card the board now offers differently stays where it was, and gets the notice again", async () => {
    const s = setup();
    const g = await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.state.pending.gate = [
      gateBody({ options: [{ id: "approve", label: "Approve" }] }),
    ];
    const before = s.hs.sent.length;
    await s.deliver(join(BEA));
    const after = s.hs.sent.slice(before);
    expect(after).toHaveLength(1);
    expect(replyTo(after[0]?.content ?? {})).toBe(g.prose);
    expect(s.store.gateEvent("gte_1")?.proseEventId).toBe(g.prose);
  });

  test("a board that cannot be read gets the notice alone", async () => {
    const s = setup();
    const g = await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.state.pending.gate = new SuperpipelineError(503, "HTTP_503");
    const before = s.hs.sent.length;
    await s.deliver(join(CAL));
    expect(s.hs.sent.slice(before).map((e) => replyTo(e.content))).toEqual([
      g.prose,
    ]);
  });

  test("an escalation settled before they joined is not posted again; a join nobody invited re-posts nothing", async () => {
    const s = setup();
    await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.store.claimGateReceipt("gte_1");
    const before = s.hs.sent.length;
    await s.deliver(join(BEA), join(`@zed:${SERVER}`));
    expect(s.hs.sent.length).toBe(before);
  });

  test("a re-post that fails is given back and finished by the retry, without moving the card twice", async () => {
    const s = setup();
    const first = await s.gate();
    await s.notice(DECISION_ESCALATED_V1, escalation());
    s.state.pending.gate = [gateBody()];
    // The card moves; the notice after it fails.
    s.state.failNotices = true;
    await s.deliver(join(BEA));
    expect(s.store.invitesOwingReposts(5)).toHaveLength(1);
    expect(s.store.gateEvent("gte_1")?.cardEventId).not.toBe(first.card);
    s.state.failNotices = false;
    s.chat.retryNotices();
    await s.chat.idle();
    expect(s.ofType(GATE_EVENT_TYPE)).toHaveLength(2);
    // Not even asked again: the card moved once for this join.
    expect(s.attempts.filter((t) => t === GATE_EVENT_TYPE)).toHaveLength(2);
    expect(s.said().filter((b) => b === MOVED_BELOW_TEXT)).toHaveLength(1);
    expect(s.marked(DECISION_ESCALATED_SUITE_TYPE)).toHaveLength(2);
    expect(s.store.invitesOwingReposts(5)).toEqual([]);
  });

  test("an overdue checks card moves below too, and an override must reference the new copy", async () => {
    const s = setup();
    await s.notice(
      DECISION_ESCALATED_V1,
      escalation({ decisionKind: "checks", decisionId: "arr_1" }),
    );
    const old = s.store.checksWaiting(BOARD, "arr_1")?.eventId ?? "";
    await s.deliver(join(BEA));
    const moved = s.store.checksWaiting(BOARD, "arr_1")?.eventId ?? "";
    expect(moved).not.toBe(old);
    expect(s.marked(CHECKS_WAITING_TYPE)).toHaveLength(2);
    await s.deliver(override(old, {}, { id: "$o1" }));
    expect(s.board.calls).toEqual([]);
    await s.deliver(override(moved, {}, { id: "$o2" }));
    expect(s.board.calls).toHaveLength(1);
  });
});

// ── quorum progress ─────────────────────────────────────────────────────────

describe("a quorum gate's recorded approval", () => {
  test("says who approved and how many more, in reply to the gate, then the structured half at its card", async () => {
    const s = setup();
    const g = await s.gate({ quorum: QUORUM });
    expect((await s.notice(GATE_APPROVAL_RECORDED_V1, approval())).status).toBe(
      "posted",
    );
    const line = s.hs.sent.find(
      (e) =>
        e.content.body ===
        gateProgressBody({
          who: "Ana",
          variantLabel: null,
          count: 1,
          required: 2,
        }),
    );
    expect(line).toBeDefined();
    expect(replyTo(line?.content ?? {})).toBe(g.prose);
    const progress = s.ofType(GATE_PROGRESS_TYPE);
    expect(progress).toHaveLength(1);
    expect(JSON.stringify(progress[0]?.content)).toContain(g.card);
    expect(JSON.stringify(progress[0]?.content)).not.toContain(ANA);
    // The board's count is recorded on the gate.
    const counted = s.store.gateEvent("gte_1")?.offer?.quorum as
      | { approvals: unknown[] }
      | undefined;
    expect(counted?.approvals).toHaveLength(1);
    // Delivered again: said once.
    await s.notice(GATE_APPROVAL_RECORDED_V1, approval());
    expect(s.ofType(GATE_PROGRESS_TYPE)).toHaveLength(1);
  });

  test("a late redelivery of an earlier approval never walks the count back", async () => {
    const s = setup();
    await s.gate({ quorum: QUORUM });
    expect(s.store.recordGateQuorum("gte_1", { approvals: [1, 2] })).toBe(true);
    expect(s.store.recordGateQuorum("gte_1", { approvals: [1] })).toBe(false);
    const recorded = s.store.gateEvent("gte_1")?.offer?.quorum as
      | { approvals: unknown[] }
      | undefined;
    expect(recorded?.approvals).toHaveLength(2);
  });

  test("an approver the plane cannot name is left out, never shown by id", async () => {
    const s = setup();
    await s.gate({ quorum: QUORUM });
    await s.notice(GATE_APPROVAL_RECORDED_V1, approval("prn_unknown"));
    expect(s.said()).toContain(
      gateProgressBody({
        who: null,
        variantLabel: null,
        count: 1,
        required: 2,
      }),
    );
    // The prose never names an id; the structured half carries it, as treaty's schema says.
    expect(s.said().join("\n")).not.toContain("prn_unknown");
  });
});

// ── held approvals ──────────────────────────────────────────────────────────

describe("a held approval", () => {
  test("released, and pulled back, each reply to the gate once, beside their structured half", async () => {
    const s = setup();
    const g = await s.gate();
    await s.notice(DECISION_RELEASED_V1, released());
    await s.notice(DECISION_RELEASED_V1, released());
    await s.notice(DECISION_PULLED_BACK_V1, pulledBack());
    expect(s.said()).toEqual([
      releasedBody(released() as never),
      pulledBackBody({ who: "Ana", comment: "wrong image" }),
    ]);
    for (const e of s.hs.sent
      .filter((x) => x.type === "m.room.message")
      .slice(-2))
      expect(replyTo(e.content)).toBe(g.prose);
    expect(s.ofType(DECISION_RELEASED_TYPE)).toHaveLength(1);
    const pulled = s.ofType(DECISION_PULLED_BACK_TYPE);
    expect(pulled).toHaveLength(1);
    expect(JSON.stringify(pulled[0]?.content)).not.toContain("prn_ana");
  });
});

// ── checks ──────────────────────────────────────────────────────────────────

describe("a failed or overridden check", () => {
  test("stands alone when no checks.waiting card was posted, once per arrival and check", async () => {
    const s = setup();
    await s.notice(CHECK_FAILED_V1, checkFailed());
    await s.notice(CHECK_FAILED_V1, checkFailed());
    await s.notice(
      CHECK_FAILED_V1,
      checkFailed({
        check: { name: "lint", provider: "ci", status: "failed" },
      }),
    );
    // The card's next arrival fails the same check: said again.
    await s.notice(CHECK_FAILED_V1, checkFailed({ arrivalId: "arr_2" }));
    expect(s.said()).toHaveLength(3);
    expect(s.said()[0]).toBe(
      checkFailedBody(checkFailed() as never, "Ship the release"),
    );
    expect(
      s.hs.sent
        .filter((e) => e.type === "m.room.message")
        .every((e) => replyTo(e.content) === null),
    ).toBe(true);
    expect(s.ofType(CHECK_FAILED_TYPE)).toHaveLength(3);
  });

  test("replies to the open checks.waiting card, and closes it when the card went back", async () => {
    const s = setup();
    await s.notice(
      DECISION_ESCALATED_V1,
      escalation({ decisionKind: "checks", decisionId: "arr_1" }),
    );
    const card = s.store.checksWaiting(BOARD, "arr_1")?.eventId ?? "";
    await s.notice(CHECK_FAILED_V1, checkFailed({ returnedTo: null }));
    expect(s.store.checksWaiting(BOARD, "arr_1")?.closedAt).toBeNull();
    await s.notice(
      CHECK_FAILED_V1,
      checkFailed({
        check: { name: "lint", provider: "ci", status: "failed" },
      }),
    );
    const lines = s.hs.sent.filter(
      (e) =>
        e.type === "m.room.message" && e.content.suite_event_type === undefined,
    );
    expect(lines.map((e) => replyTo(e.content))).toEqual([card, card]);
    expect(s.store.checksWaiting(BOARD, "arr_1")?.closedAt).not.toBeNull();
    // Closed: the next one stands alone.
    await s.notice(CHECK_OVERRIDDEN_V1, checkOverridden());
    expect(
      replyTo(
        s.hs.sent.filter((e) => e.type === "m.room.message").at(-1)?.content ??
          {},
      ),
    ).toBeNull();
  });

  test("an override names who by their label, never their id; an empty title falls back to one a reminder recorded", async () => {
    const s = setup();
    await s.notice(
      DECISION_REMINDED_V1,
      timeout({ decisionKind: "checks", decisionId: "arr_1" }),
    );
    await s.notice(CHECK_OVERRIDDEN_V1, checkOverridden({ cardTitle: "" }));
    expect(s.said()).toContain(
      checkOverriddenBody(
        checkOverridden() as never,
        "Ana",
        "Ship the release",
      ),
    );
    expect(JSON.stringify(s.ofType(CHECK_OVERRIDDEN_TYPE))).not.toContain(
      "prn_ana",
    );
  });

  test("a board with no room here says nothing", async () => {
    const s = setup();
    s.store.upsertBoard({
      boardId: "brd_new",
      spTenantId: "t",
      orgId: "org_1",
      invitees: [],
    });
    expect(
      intakeNotice(
        s.store,
        CHECK_FAILED_V1,
        checkFailed({ boardId: "brd_new" }),
      ),
    ).toEqual({
      status: "ignored",
      reason: "no room",
    });
  });
});

// ── pull-backs and overrides from chat ──────────────────────────────────────

function pullBack(
  eventId: string,
  over: Record<string, unknown> = {},
  { sender = ANA, roomId = ROOM, id = "$pb1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: id,
    content: {
      msgtype: "m.text",
      body: "Pulled back: wrong image",
      schema_version: 1,
      suite_event_type: GATE_PULL_BACK_V2_SUITE_TYPE,
      gate_id: "gte_1",
      comment: "wrong image",
      "m.relates_to": { rel_type: "m.reference", event_id: eventId },
      ...over,
    },
  };
}

function override(
  eventId: string,
  over: Record<string, unknown> = {},
  { sender = ANA, roomId = ROOM, id = "$ov1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: id,
    content: {
      msgtype: "m.text",
      body: "Override build: flaky runner",
      schema_version: 1,
      suite_event_type: CHECK_OVERRIDE_V2_SUITE_TYPE,
      board_id: BOARD,
      card_id: CARD,
      check_name: "build",
      comment: "flaky runner",
      "m.relates_to": { rel_type: "m.reference", event_id: eventId },
      ...over,
    },
  };
}

describe("a pull-back from chat", () => {
  test("is carried to the board as the person, and says nothing itself", async () => {
    const s = setup();
    const g = await s.gate();
    const before = s.hs.sent.length;
    await s.deliver(pullBack(g.card));
    expect(s.board.calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/gates/gte_1/pull-back`,
        authorization: `Bearer ${jwt({ sub: "prn_ana" })}`,
        body: { comment: "wrong image" },
      },
    ]);
    expect(s.hs.sent.length).toBe(before);
    // Its prose may be referenced instead.
    await s.deliver(pullBack(g.prose, {}, { id: "$pb2" }));
    expect(s.board.calls).toHaveLength(2);
  });

  test("without a comment, or with one too long, is refused in words after attribution and never reaches the board", async () => {
    const s = setup();
    const g = await s.gate();
    await s.deliver(pullBack(g.card, { comment: "  " }));
    await s.deliver(
      pullBack(g.card, { comment: "x".repeat(9000) }, { id: "$pb2" }),
    );
    expect(s.board.calls).toEqual([]);
    expect(s.said()).toEqual([
      PULL_BACK_COMMENT_REQUIRED_TEXT,
      "That comment is longer than the board takes (at most 8192 bytes). Nothing has changed.",
    ]);
    // A stranger is told nothing, comment or not.
    await s.deliver(
      pullBack(g.card, { comment: "  " }, { sender: STRANGER, id: "$pb3" }),
    );
    expect(s.said()).toHaveLength(2);
  });

  test("a gate never posted here, a reference that disagrees, or another room changes nothing and says nothing", async () => {
    const s = setup();
    const g = await s.gate();
    await s.deliver(
      pullBack(g.card, { gate_id: "gte_nope" }, { id: "$a" }),
      pullBack("$elsewhere", {}, { id: "$b" }),
      pullBack(g.card, {}, { roomId: OTHER_ROOM, id: "$c" }),
    );
    expect(s.board.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });

  test("an agent never pulls an approval back, and is not answered", async () => {
    const s = setup();
    const g = await s.gate();
    await s.deliver(pullBack(g.card, {}, { sender: AGENT }));
    expect(s.board.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });

  test("a plane that cannot be asked is said, and nothing is carried", async () => {
    const s = setup();
    const g = await s.gate();
    s.plane.state.down = true;
    await s.deliver(pullBack(g.card));
    expect(s.board.calls).toEqual([]);
    expect(s.said()).toEqual([IDENTITY_UNAVAILABLE_TEXT]);
  });

  test("each board refusal is said in one sentence", async () => {
    const s = setup();
    const g = await s.gate();
    let i = 0;
    for (const code of [
      "APPROVAL_RELEASED",
      "GATE_NOT_HELD",
      "SEPARATION_OF_DUTIES",
      "INVALID_COMMENT",
      "WHATEVER",
    ]) {
      s.board.state.next = { status: 409, code };
      await s.deliver(pullBack(g.card, {}, { id: `$r${i++}` }));
    }
    s.board.state.next = "unreachable";
    await s.deliver(pullBack(g.card, {}, { id: "$unreachable" }));
    expect(s.said()).toEqual(
      [
        "APPROVAL_RELEASED",
        "GATE_NOT_HELD",
        "SEPARATION_OF_DUTIES",
        "INVALID_COMMENT",
        "WHATEVER",
        "UNREACHABLE",
      ].map(pullBackRefusalText),
    );
    expect(pullBackRefusalText("UNREACHABLE")).toContain(
      "did not reach the board",
    );
  });

  test("a malformed one is refused there, never read as a typed reply to the question open in the room", async () => {
    const s = setup();
    intakeQuestion(s.store, questionBody());
    await s.chat.postQuestion("elc_1");
    const questionsAnswered = () =>
      s.board.calls.filter((c) => c.path.includes("/elicitations/"));
    const chat = s.chat;
    // A pull-back whose body reads "1" and which treaty does not parse (no gate id).
    await s.deliver({
      type: "m.room.message",
      room_id: ROOM,
      sender: ANA,
      event_id: "$m1",
      content: {
        msgtype: "m.text",
        body: "1",
        suite_event_type: GATE_PULL_BACK_V2_SUITE_TYPE,
      },
    });
    await s.deliver({
      type: "m.room.message",
      room_id: ROOM,
      sender: ANA,
      event_id: "$m2",
      content: {
        msgtype: "m.text",
        body: "1",
        suite_event_type: CHECK_OVERRIDE_V2_SUITE_TYPE,
      },
    });
    await chat.idle();
    expect(questionsAnswered()).toEqual([]);
    // The same "1" typed plainly does answer it: the test can see a typed reply.
    await s.deliver({
      type: "m.room.message",
      room_id: ROOM,
      sender: ANA,
      event_id: "$m3",
      content: { msgtype: "m.text", body: "1" },
    });
    expect(questionsAnswered()).toHaveLength(1);
  });
});

describe("a check override from chat", () => {
  async function waiting(s: ReturnType<typeof setup>) {
    await s.notice(
      DECISION_ESCALATED_V1,
      escalation({ decisionKind: "checks", decisionId: "arr_1" }),
    );
    return s.store.checksWaiting(BOARD, "arr_1")?.eventId ?? "";
  }

  test("is carried to the board's route as the person, and says nothing itself", async () => {
    const s = setup();
    const card = await waiting(s);
    const before = s.hs.sent.length;
    await s.deliver(override(card));
    expect(s.board.calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/cards/${CARD}/checks/build/override`,
        authorization: `Bearer ${jwt({ sub: "prn_ana" })}`,
        body: { comment: "flaky runner" },
      },
    ]);
    expect(s.hs.sent.length).toBe(before);
  });

  test("a card never posted here, or one whose room, board or card disagrees, changes nothing and says nothing", async () => {
    const s = setup();
    const card = await waiting(s);
    await s.deliver(
      override("$nothing", {}, { id: "$a" }),
      override(card, { board_id: "brd_other" }, { id: "$b" }),
      override(card, { card_id: "crd_other" }, { id: "$c" }),
      override(card, {}, { roomId: OTHER_ROOM, id: "$d" }),
      override(card, {}, { sender: AGENT, id: "$e" }),
    );
    expect(s.board.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });

  test("without a comment is refused in words; each board refusal is said", async () => {
    const s = setup();
    const card = await waiting(s);
    await s.deliver(override(card, { comment: "" }));
    expect(s.board.calls).toEqual([]);
    let i = 0;
    for (const code of [
      "CHECK_OVERRIDE_NOT_ALLOWED",
      "CHECK_NOT_OPEN",
      "CHECK_NOT_FOUND",
      "CARD_NOT_FOUND",
    ]) {
      s.board.state.next = { status: 403, code };
      await s.deliver(override(card, {}, { id: `$r${i++}` }));
    }
    expect(s.said()).toEqual([
      CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT,
      ...[
        "CHECK_OVERRIDE_NOT_ALLOWED",
        "CHECK_NOT_OPEN",
        "CHECK_NOT_FOUND",
        "CARD_NOT_FOUND",
      ].map(checkOverrideRefusalText),
    ]);
  });
});

// ── treaty's corpus ─────────────────────────────────────────────────────────

type Case = { why: string; refusedBy: string; body: Record<string, unknown> };
const corpus: {
  schemas: Record<
    string,
    { valid: Record<string, Record<string, unknown>>; invalid: Case[] }
  >;
} = JSON.parse(
  readFileSync(
    Bun.resolveSync(
      "@superjackfruitlabs/treaty-matrix-events/examples.json",
      import.meta.dir,
    ),
    "utf8",
  ),
);

/** The gate and the checks card the corpus references, as this service would have recorded them. */
function recordCorpus(s: ReturnType<typeof setup>) {
  s.store.upsertBoard({
    boardId: "brd_7c1f",
    spTenantId: "t",
    orgId: "org_1",
    invitees: [ANA],
  });
  intakeGate(s.store, gateBody({ gateId: "gate_6e19" }));
  s.store.claimGateEvent("gate_6e19", BOARD, ROOM);
  s.store.recordGateProse("gate_6e19", "$prose");
  s.store.recordGatePosted("gate_6e19", "$gateEventId");
  s.store.claimChecksWaiting({
    boardId: "brd_7c1f",
    arrivalId: "arr_1",
    cardId: "crd_8a40",
    cardTitle: "Ship it",
    stageKey: "review",
    stageName: null,
    roomId: ROOM,
  });
  s.store.recordChecksWaitingPosted(
    "brd_7c1f",
    "arr_1",
    "$checksWaitingEventId",
  );
}

for (const type of [
  GATE_PULL_BACK_V2_SUITE_TYPE,
  CHECK_OVERRIDE_V2_SUITE_TYPE,
]) {
  describe(`treaty's corpus: ${type}`, () => {
    const cases = corpus.schemas[type] ?? { valid: {}, invalid: [] };
    async function reaches(content: Record<string, unknown>) {
      const s = setup();
      recordCorpus(s);
      await s.deliver({
        type: "m.room.message",
        room_id: ROOM,
        sender: ANA,
        event_id: "$corpus",
        content,
      });
      return s.board.calls.length;
    }
    test("has valid and invalid cases", () => {
      expect(Object.keys(cases.valid).length).toBeGreaterThan(0);
      expect(cases.invalid.length).toBeGreaterThan(0);
    });
    for (const [label, content] of Object.entries(cases.valid)) {
      test(`reaches the board once, as the person: ${label}`, async () => {
        expect(await reaches(content)).toBe(1);
      });
    }
    for (const c of cases.invalid) {
      test(`never reaches the board (${c.refusedBy}): ${c.why}`, async () => {
        expect(await reaches(c.body)).toBe(0);
      });
    }
  });
}

// ── what never reaches a log ────────────────────────────────────────────────

test("no secret, token, URL or comment reaches a log on any path", async () => {
  const s = setup();
  const g = await s.gate({ quorum: QUORUM });
  await s.notice(DECISION_ESCALATED_V1, escalation());
  s.state.inviteFails = true;
  await s.gate({ gateId: "gte_2" });
  s.store.forgetEscalationInvite(BOARD, BEA);
  await s.notice(DECISION_ESCALATED_V1, escalation({ decisionId: "gte_2" }));
  await s.notice(GATE_APPROVAL_RECORDED_V1, approval());
  await s.notice(DECISION_PULLED_BACK_V1, pulledBack());
  await s.notice(CHECK_OVERRIDDEN_V1, checkOverridden());
  await s.deliver(pullBack(g.card));
  s.board.state.next = "unreachable";
  await s.deliver(pullBack(g.card, {}, { id: "$x2" }));
  s.plane.state.down = true;
  await s.deliver(pullBack(g.card, {}, { id: "$x3" }));
  s.hs.fail(true);
  s.state.adminsDown = true;
  await s.notice(
    DECISION_ESCALATED_V1,
    escalation({ decisionKind: "checks", decisionId: "arr_9" }),
  );
  await s.notice(CHECK_FAILED_V1, checkFailed({ arrivalId: "arr_9" }));
  const everything = s.lines.join("\n");
  for (const secret of [
    CREDENTIAL.secret,
    CREDENTIAL.id,
    jwt({ sub: "prn_ana" }),
    PLANE_URL,
    SP_URL,
    AS_TOKEN,
    "ECONNREFUSED",
    "wrong image",
    "flaky runner",
    BEA,
    CAL,
  ])
    expect(everything).not.toContain(secret);
});
