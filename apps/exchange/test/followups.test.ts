import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ATTENTION_ANSWER_V2_SUITE_TYPE,
  ATTENTION_OUTCOME_TYPE,
  ATTENTION_V2_SUITE_TYPE,
  DELIVERY_ANSWER_V2_SUITE_TYPE,
  DELIVERY_V2_SUITE_TYPE,
  GATE_OUTCOME_TYPE,
  attentionOutcomeContent,
  attentionV2Content,
  deliveryOutcomeContent,
  deliveryV2Content,
  type AttentionPendingDelivery,
  type DeliveryPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import { createClient, type MatrixEvent } from "../src/appservice/index.ts";
import {
  ATTENTION_PENDING_V1,
  DELIVERY_PENDING_V1,
  FOLLOWUP_REFUSAL_TEXT,
  IDENTITY_UNAVAILABLE_TEXT,
  SuperpipelineError,
  WAIT_CHANGED_TEXT,
  AccountsError,
  answerAttentionAtSuperpipeline,
  answerFollowupAtSuperpipeline,
  attentionOffer,
  attentionTxnId,
  createAccounts,
  createAttentionAnswers,
  createBoardChat,
  createBoardRooms,
  createFollowupAnswers,
  createRoomSender,
  createSuperpipelineReads,
  followupOffer,
  followupTxnId,
  intakeAttention,
  intakeFollowup,
  sweepAttention,
  sweepFollowups,
} from "../src/board-chat/index.ts";
import { createRelayHandler } from "../src/routes/relay.ts";
import type { WaitKey } from "../src/store/index.ts";
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
import { captureLog, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ROOM = `!board:${SERVER}`;
const OTHER_ROOM = `!other:${SERVER}`;
const BOARD = "brd_7c1f";
const POST =
  "Our next release ships today.\n\nThanks to everyone who tested it.";

/** A follow-up as SuperPipeline publishes it (the hub's fixture). */
function owed(
  over: Partial<DeliveryPendingDelivery> = {},
): DeliveryPendingDelivery {
  return {
    event: "delivery.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: "crd_6b40",
    cardTitle: "Announce the release",
    gateId: "gate_8f3a",
    stageKey: "approve",
    approvalSubject: {
      id: "aps_2c9e71",
      digest: "sha256:9b2f4e0c1a7d",
      schema: "social-publish/v1",
      revision: 1,
      expiresAt: "2030-01-02T03:04:05Z",
      preview: [
        { type: "text", label: "Post", text: POST },
        { type: "field", label: "Account", value: "@fixture_account on X" },
      ],
      previewComplete: true,
    },
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
      {
        id: "switch_to_automatic",
        label: "Post it automatically",
        meaning: "approve",
        needsComment: false,
        delivery: "automatic",
      },
    ],
    ts: "2026-11-07T10:00:00.000Z",
    ...over,
  };
}

const INPUT = {
  kind: "text",
  label: "What should the next attempt do?",
  required: true,
  maxLength: 2730,
};

/** A blocked card as SuperPipeline publishes it (the hub's fixture). */
function blocked(
  over: Partial<AttentionPendingDelivery> = {},
): AttentionPendingDelivery {
  return {
    event: "attention.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: "crd_6b40",
    cardTitle: "Ship the release",
    stageKey: "build",
    stageName: "Build",
    waitId: "wait_0123456789abcdef",
    reason: "blocked",
    detail: "the staging database is down",
    summary: "Staging DB down",
    failureCount: null,
    earlierStages: [{ key: "plan", name: "Plan" }],
    options: [
      {
        id: "resume_here",
        label: "Resume here",
        meaning: "approve",
        needsComment: false,
        input: INPUT,
      },
      {
        id: "resume_at:plan",
        label: "Resume at Plan",
        meaning: "choose",
        needsComment: false,
        input: INPUT,
      },
      {
        id: "archive",
        label: "Archive",
        meaning: "reject",
        needsComment: false,
      },
    ],
    ts: "2026-11-08T10:00:00.000Z",
    ...over,
  };
}

const KEY: WaitKey = {
  boardId: BOARD,
  cardId: "crd_6b40",
  waitId: "wait_0123456789abcdef",
};

function setup({
  joined = true,
  plaintextRooms = true,
}: { joined?: boolean; plaintextRooms?: boolean } = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const store = t.store;
  const hs = fakeHomeserver();
  const plane = fakePlane();
  const board = fakeBoard();
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
    encryptNewRooms: false,
    log,
  });
  const sender = createRoomSender({
    store,
    client,
    crypto: null,
    plaintextRooms,
  });
  const accounts = createAccounts({
    url: PLANE_URL,
    credential: CREDENTIAL,
    fetch: plane.fetch,
  });
  const mint = (subject: { principalId: string; senderMxid: string }) =>
    accounts.assert({ ...subject, audience: SP_URL });
  const followups = createFollowupAnswers({
    store,
    client: sender,
    speaker: rooms.speaker,
    accounts,
    answerFollowup: (input) =>
      answerFollowupAtSuperpipeline(input, {
        baseUrl: SP_URL,
        mint,
        fetch: board.fetch,
      }),
    log,
  });
  const attention = createAttentionAnswers({
    store,
    client: sender,
    speaker: rooms.speaker,
    accounts,
    answerAttention: (input) =>
      answerAttentionAtSuperpipeline(input, {
        baseUrl: SP_URL,
        mint,
        fetch: board.fetch,
      }),
    log,
  });
  const chat = createBoardChat({
    store,
    sender,
    rooms,
    crypto: null,
    followups,
    attention,
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
    store.recordMembership(roomId, ANA, joined ? "join" : "invite");
  }

  /** Deliver and post a follow-up, as the relay would; answers its message's event id. */
  async function owe(body: DeliveryPendingDelivery = owed()): Promise<string> {
    intakeFollowup(store, body);
    const out = await chat.postFollowup(body.gateId);
    if (out.status !== "posted") throw new Error(`not posted: ${out.status}`);
    return out.eventId;
  }
  /** Deliver and post a waiting card; answers its message's event id. */
  async function wait(
    body: AttentionPendingDelivery = blocked(),
  ): Promise<string> {
    intakeAttention(store, body);
    const out = await chat.postAttention({
      boardId: body.boardId,
      cardId: body.cardId,
      waitId: body.waitId,
    });
    if (out.status !== "posted") throw new Error(`not posted: ${out.status}`);
    return out.eventId;
  }
  async function deliver(...events: MatrixEvent[]) {
    await chat.onEvents("txn", events);
    await chat.idle();
  }
  /** Every plain line said in the room, in order. */
  const said = () =>
    hs.sent
      .filter(
        (e) =>
          e.type === "m.room.message" &&
          e.content.suite_event_type === undefined,
      )
      .map((e) => e.content.body);
  const outcomes = (type: string) =>
    hs.sent.filter((e) => e.type === type).map((e) => e.content);

  return {
    store,
    hs,
    plane,
    board,
    chat,
    sender,
    accounts,
    followups,
    attention,
    lines,
    owe,
    wait,
    deliver,
    said,
    outcomes,
  };
}

function deliveryAnswer(
  eventId: string,
  over: Record<string, unknown> = {},
  { sender = ANA, roomId = ROOM, id = "$answer1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: id,
    content: {
      msgtype: "m.text",
      body: "Live at https://social.example/posts/1",
      schema_version: 1,
      suite_event_type: DELIVERY_ANSWER_V2_SUITE_TYPE,
      gate_id: "gate_8f3a",
      option_id: "record_live_url",
      text: "https://social.example/posts/1",
      "m.relates_to": { rel_type: "m.reference", event_id: eventId },
      ...over,
    },
  };
}

function attentionAnswer(
  eventId: string,
  over: Record<string, unknown> = {},
  { sender = ANA, roomId = ROOM, id = "$answer1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: id,
    content: {
      msgtype: "m.text",
      body: "Resume here",
      suite_event_type: ATTENTION_ANSWER_V2_SUITE_TYPE,
      board_id: BOARD,
      card_id: "crd_6b40",
      wait_id: "wait_0123456789abcdef",
      option_id: "resume_here",
      text: "The database is back; run the migrations again.",
      "m.relates_to": { rel_type: "m.reference", event_id: eventId },
      ...over,
    },
  };
}

// ── the relay ───────────────────────────────────────────────────────────────

describe("the relay's delivery.pending and attention.pending", () => {
  function relay() {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const followups: string[] = [];
    const waits: WaitKey[] = [];
    const handle = createRelayHandler({
      secret: "relay-secret-for-tests",
      store: t.store,
      log: () => undefined,
      onFollowupAccepted: (id) => followups.push(id),
      onAttentionAccepted: (k) => waits.push(k),
    });
    t.store.upsertBoard({
      boardId: BOARD,
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [ANA],
    });
    return { handle, store: t.store, followups, waits };
  }

  test("are the catalogue's CloudEvents types", () => {
    expect(DELIVERY_PENDING_V1).toBe(
      "com.superjackfruit.superpipeline.delivery.pending.v1",
    );
    expect(ATTENTION_PENDING_V1).toBe(
      "com.superjackfruit.superpipeline.attention.pending.v1",
    );
  });

  test("an opted-in board's follow-up and waiting card are recorded once and handed on, a redelivery too", async () => {
    const r = relay();
    for (let i = 0; i < 2; i++) {
      const f = await r.handle(await relayRequest(owed(), DELIVERY_PENDING_V1));
      expect(await f.json()).toEqual({ status: "accepted" });
      const a = await r.handle(
        await relayRequest(blocked(), ATTENTION_PENDING_V1),
      );
      expect(await a.json()).toEqual({ status: "accepted" });
    }
    expect(r.followups).toEqual(["gate_8f3a", "gate_8f3a"]);
    expect(r.waits).toEqual([KEY, KEY]);
    expect(r.store.unpostedFollowups()).toHaveLength(1);
    expect(r.store.unpostedAttention()).toHaveLength(1);
  });

  test("another board's, or a disabled board's, is ignored and recorded nowhere", async () => {
    const r = relay();
    for (const [body, type] of [
      [owed({ boardId: "brd_x" }), DELIVERY_PENDING_V1],
      [blocked({ boardId: "brd_x" }), ATTENTION_PENDING_V1],
    ] as const) {
      const res = await r.handle(await relayRequest(body, type));
      expect(await res.json()).toEqual({ status: "ignored" });
    }
    r.store.disableBoard(BOARD);
    for (const [body, type] of [
      [owed(), DELIVERY_PENDING_V1],
      [blocked(), ATTENTION_PENDING_V1],
    ] as const) {
      const res = await r.handle(await relayRequest(body, type));
      expect(await res.json()).toEqual({ status: "ignored" });
    }
    expect(r.store.unpostedFollowups()).toHaveLength(0);
    expect(r.store.unpostedAttention()).toHaveLength(0);
    expect(r.followups).toEqual([]);
    expect(r.waits).toEqual([]);
  });

  test("a body that is not what its type says is 400", async () => {
    const r = relay();
    const f = await r.handle(
      await relayRequest({ ...owed(), gateId: "" }, DELIVERY_PENDING_V1),
    );
    expect(f.status).toBe(400);
    const a = await r.handle(
      await relayRequest({ ...blocked(), waitId: "" }, ATTENTION_PENDING_V1),
    );
    expect(a.status).toBe(400);
    const crossed = await r.handle(
      await relayRequest(blocked(), DELIVERY_PENDING_V1),
    );
    expect(crossed.status).toBe(400);
  });
});

// ── a follow-up in the room ─────────────────────────────────────────────────

describe("a follow-up is posted into its board's room", () => {
  test("as one message: treaty's delivery.v2, and what it offered recorded", async () => {
    const s = setup();
    const eventId = await s.owe();
    expect(s.hs.sent).toHaveLength(1);
    const [msg] = s.hs.sent;
    expect(msg?.type).toBe("m.room.message");
    expect(msg?.txnId).toBe(followupTxnId("gate_8f3a", "prose"));
    expect(msg?.content).toEqual(deliveryV2Content(owed()));
    expect(msg?.content.suite_event_type).toBe(DELIVERY_V2_SUITE_TYPE);
    const f = s.store.followupEvent("gate_8f3a");
    expect(f?.eventId).toBe(eventId);
    expect(f?.cardId).toBe("crd_6b40");
    expect(f?.offer).toEqual(followupOffer(owed()));
    expect(f?.offer).toEqual({
      options: [
        {
          id: "record_live_url",
          label: "Record the live link",
          input: { kind: "url", required: true, max_length: 2000 },
        },
        { id: "switch_to_automatic", label: "Post it automatically" },
      ],
      subjectPreviewComplete: true,
    });
  });

  test("on an incomplete preview, automatic delivery is not offered and the preview is recorded incomplete", async () => {
    const s = setup();
    await s.owe(
      owed({
        approvalSubject: {
          id: "aps_2c9e71",
          digest: "sha256:9b2f4e0c1a7d",
          schema: "social-publish/v1",
          revision: 1,
          previewComplete: false,
          preview: [{ type: "text", text: POST }],
        },
      }),
    );
    const offer = s.store.followupEvent("gate_8f3a")?.offer;
    expect(offer?.options.map((o) => o.id)).toEqual(["record_live_url"]);
    expect(offer?.subjectPreviewComplete).toBe(false);
  });

  test("is posted once, however often it is offered", async () => {
    const s = setup();
    await s.owe();
    expect((await s.chat.postFollowup("gate_8f3a")).status).toBe("already");
    s.chat.followupAccepted("gate_8f3a");
    await s.chat.idle();
    expect(s.hs.sent).toHaveLength(1);
  });

  test("is held, unclaimed, until a person joins; the join posts it", async () => {
    const s = setup({ joined: false });
    intakeFollowup(s.store, owed());
    expect((await s.chat.postFollowup("gate_8f3a")).status).toBe("held");
    expect(s.store.followupEvent("gate_8f3a")).toBeNull();
    await s.deliver({
      type: "m.room.member",
      room_id: ROOM,
      state_key: ANA,
      sender: ANA,
      content: { membership: "join" },
    });
    expect(s.hs.sent).toHaveLength(1);
    expect(s.store.followupEvent("gate_8f3a")?.postedAt).not.toBeNull();
  });

  test("a failed send keeps its claim, and the retry is the same message", async () => {
    const s = setup();
    intakeFollowup(s.store, owed());
    s.hs.fail(true);
    expect(await s.chat.postFollowup("gate_8f3a")).toEqual({
      status: "failed",
      step: "send",
    });
    expect(s.store.followupEvent("gate_8f3a")?.postedAt).toBeNull();
    s.hs.fail(false);
    expect((await s.chat.postFollowup("gate_8f3a")).status).toBe("posted");
    await s.chat.postFollowup("gate_8f3a");
    expect(s.hs.sent).toHaveLength(1);
  });

  test("one the board stopped owing before it was posted is never posted", async () => {
    const s = setup({ joined: false });
    intakeFollowup(s.store, owed());
    expect(await s.chat.settleFollowup("gate_8f3a")).toBe("withdrawn");
    s.store.recordMembership(ROOM, ANA, "join");
    expect(await s.chat.postFollowup("gate_8f3a")).toEqual({
      status: "skipped",
      reason: "settled",
    });
    expect(s.hs.sent).toHaveLength(0);
  });

  test("a room made in plaintext is not posted into while plaintext rooms are off", async () => {
    const s = setup({ plaintextRooms: false });
    intakeFollowup(s.store, owed());
    intakeAttention(s.store, blocked());
    expect(await s.chat.postFollowup("gate_8f3a")).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    expect(await s.chat.postAttention(KEY)).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    expect(s.hs.sent).toHaveLength(0);
    expect(s.store.followupEvent("gate_8f3a")).toBeNull();
    expect(s.store.attentionEvent(KEY)).toBeNull();
  });

  test("a room it has just made in plaintext is not posted into either, nor claimed", async () => {
    const s = setup({ plaintextRooms: false });
    s.store.upsertBoard({
      boardId: "brd_new",
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [ANA],
    });
    intakeFollowup(s.store, owed({ boardId: "brd_new", gateId: "gate_n" }));
    expect(await s.chat.postFollowup("gate_n")).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    expect(s.hs.created).toHaveLength(1);
    expect(s.store.followupEvent("gate_n")).toBeNull();
    expect(s.hs.sent).toHaveLength(0);
  });
});

// ── delivery.answer.v2 ──────────────────────────────────────────────────────

describe("delivery.answer.v2", () => {
  test("a live link is recorded at the board as the person, and one receipt says who", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(deliveryAnswer(ev));
    expect(s.board.calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/gates/gate_8f3a/delivery`,
        authorization: `Bearer ${jwt({ sub: "prn_ana" })}`,
        body: { liveUrl: "https://social.example/posts/1" },
      },
    ]);
    expect(s.said()).toEqual(["Live link recorded by Ana — the board has it."]);
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toEqual([
      deliveryOutcomeContent(
        "gate_8f3a",
        { boardId: BOARD, eventId: ev },
        "record_live_url",
        "Ana",
      ),
    ]);
    expect(s.hs.sent.at(-1)?.txnId).toBe(
      followupTxnId("gate_8f3a", "outcome.card"),
    );
  });

  test("switching to automatic sends mode automatic, and says so", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(
      deliveryAnswer(ev, { option_id: "switch_to_automatic", text: undefined }),
    );
    expect(s.board.calls.map((c) => c.body)).toEqual([{ mode: "automatic" }]);
    expect(s.said()).toEqual([
      "Switched to automatic delivery by Ana — the board has it.",
    ]);
  });

  test("a repeated answer never reaches the board again and leaves one receipt", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(deliveryAnswer(ev), deliveryAnswer(ev, {}, { id: "$a2" }));
    expect(s.board.calls).toHaveLength(1);
    expect(s.said()).toHaveLength(1);
  });

  test("a missing, non-https, unaddressable or too long link is refused, said, and never sent", async () => {
    const s = setup();
    const ev = await s.owe();
    const cases: Array<[unknown, keyof typeof FOLLOWUP_REFUSAL_TEXT]> = [
      [undefined, "input-required"],
      ["   ", "input-required"],
      ["http://social.example/posts/1", "url-invalid"],
      ["javascript:alert(1)", "url-invalid"],
      ["https://", "url-invalid"],
      [`https://social.example/${"p".repeat(2100)}`, "text-too-long"],
    ];
    let i = 0;
    for (const [text] of cases)
      await s.deliver(deliveryAnswer(ev, { text }, { id: `$r${i++}` }));
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual(cases.map(([, r]) => FOLLOWUP_REFUSAL_TEXT[r]));
  });

  test("an option the follow-up did not offer is refused", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(deliveryAnswer(ev, { option_id: "remind_me" }));
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([FOLLOWUP_REFUSAL_TEXT["bad-option"]]);
  });

  test("switching to automatic is refused when the recorded preview was incomplete, even if recorded as offered", async () => {
    const s = setup();
    intakeFollowup(s.store, owed());
    s.store.claimFollowupEvent("gate_8f3a", BOARD, "crd_6b40", ROOM, {
      ...followupOffer(owed()),
      subjectPreviewComplete: false,
    });
    s.store.recordFollowupPosted("gate_8f3a", "$followup");
    await s.deliver(
      deliveryAnswer("$followup", { option_id: "switch_to_automatic" }),
    );
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([FOLLOWUP_REFUSAL_TEXT["preview-incomplete"]]);
  });

  test("attribution refusals are silent: another reference or room, unlinked, an agent, this service's own namespace", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(
      deliveryAnswer(ev, {
        "m.relates_to": { rel_type: "m.reference", event_id: "$other" },
      }),
      deliveryAnswer(ev, {}, { roomId: OTHER_ROOM, id: "$b" }),
      deliveryAnswer(ev, {}, { sender: STRANGER, id: "$c" }),
      deliveryAnswer(ev, {}, { sender: AGENT, id: "$d" }),
      deliveryAnswer(
        ev,
        {},
        { sender: `@superexchange_x:${SERVER}`, id: "$e" },
      ),
      deliveryAnswer(ev, { gate_id: "gate_unknown" }, { id: "$f" }),
    );
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([]);
    expect(s.store.followupEvent("gate_8f3a")?.outcomePostedAt).toBeNull();
  });

  test("this service's own namespace is never answered for, even when the plane links it to a person", async () => {
    const s = setup();
    const ev = await s.owe();
    const own = `@superexchange_x:${SERVER}`;
    s.plane.identities[own] = "prn_ana";
    expect(
      await s.followups.handle(deliveryAnswer(ev, {}, { sender: own })),
    ).toEqual({ status: "ignored", reason: "own-namespace" });
    expect(s.board.calls).toHaveLength(0);
  });

  test("an unlinked sender and a room this service does not own are ignored as such", async () => {
    const s = setup();
    const ev = await s.owe();
    expect(
      await s.followups.handle(deliveryAnswer(ev, {}, { sender: STRANGER })),
    ).toEqual({ status: "ignored", reason: "unlinked-sender" });
    expect(
      await s.followups.handle(
        deliveryAnswer(ev, {}, { roomId: `!elsewhere:${SERVER}` }),
      ),
    ).toEqual({ status: "ignored", reason: "not-a-board-room" });
    expect(
      await s.attention.handle(
        attentionAnswer("$x", {}, { roomId: `!elsewhere:${SERVER}` }),
      ),
    ).toEqual({ status: "ignored", reason: "not-a-board-room" });
    expect(s.board.calls).toHaveLength(0);
  });

  test("a receipt already claimed while the answer was carried is not posted twice", async () => {
    const s = setup();
    const ev = await s.owe();
    const card = await s.wait();
    const answers = createFollowupAnswers({
      store: s.store,
      client: s.sender,
      speaker: SPEAKER,
      accounts: s.accounts,
      answerFollowup: async () => {
        s.store.settleFollowupEvent("gate_8f3a");
        return { ok: true };
      },
      log: () => undefined,
    });
    const waits = createAttentionAnswers({
      store: s.store,
      client: s.sender,
      speaker: SPEAKER,
      accounts: s.accounts,
      answerAttention: async () => {
        s.store.settleAttentionEvent(KEY);
        return { ok: true };
      },
      log: () => undefined,
    });
    await answers.handle(deliveryAnswer(ev));
    await waits.handle(attentionAnswer(card));
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toEqual([]);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toEqual([]);
  });

  test("a board no longer opted in is not answered for", async () => {
    const s = setup();
    const ev = await s.owe();
    s.store.disableBoard(BOARD);
    await s.deliver(deliveryAnswer(ev));
    expect(s.board.calls).toHaveLength(0);
  });

  test("the plane down is said, and nothing reaches the board", async () => {
    const s = setup();
    const ev = await s.owe();
    s.plane.state.down = true;
    await s.deliver(deliveryAnswer(ev));
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([IDENTITY_UNAVAILABLE_TEXT]);
  });

  test("the board's refusal is said, no receipt is posted, and the follow-up stays open", async () => {
    const s = setup();
    const ev = await s.owe();
    s.board.state.next = { status: 409, code: "APPROVAL_EXPIRED" };
    await s.deliver(deliveryAnswer(ev));
    expect(s.said()).toEqual([
      "That did not go through (APPROVAL_EXPIRED). Nothing has changed.",
    ]);
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toEqual([]);
    s.board.state.next = { status: 200 };
    await s.deliver(deliveryAnswer(ev, {}, { id: "$again" }));
    expect(s.board.calls).toHaveLength(2);
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toHaveLength(1);
  });
});

// ── a waiting card in the room ──────────────────────────────────────────────

describe("a waiting card is posted into its board's room", () => {
  test("as one message: treaty's attention.v2, and what it offered recorded", async () => {
    const s = setup();
    const eventId = await s.wait();
    expect(s.hs.sent).toHaveLength(1);
    const [msg] = s.hs.sent;
    expect(msg?.txnId).toBe(attentionTxnId(KEY, "prose"));
    expect(msg?.content).toEqual(attentionV2Content(blocked()));
    expect(msg?.content.suite_event_type).toBe(ATTENTION_V2_SUITE_TYPE);
    const card = s.store.attentionEvent(KEY);
    expect(card?.eventId).toBe(eventId);
    expect(card?.options).toEqual(attentionOffer(blocked()));
    expect(card?.options.map((o) => o.id)).toEqual([
      "resume_here",
      "resume_at:plan",
      "archive",
    ]);
  });

  test("a redelivered wait is posted once; the same card parked again is a new card", async () => {
    const s = setup();
    await s.wait();
    expect((await s.chat.postAttention(KEY)).status).toBe("already");
    await s.wait(blocked({ waitId: "wait_fedcba9876543210" }));
    expect(s.hs.sent).toHaveLength(2);
    expect(s.hs.sent[1]?.txnId).not.toBe(s.hs.sent[0]?.txnId);
  });

  test("two waits whose ids contain the separator never share a transaction id", () => {
    const a = attentionTxnId(
      { boardId: "b", cardId: "a.b", waitId: "c" },
      "prose",
    );
    const b = attentionTxnId(
      { boardId: "b", cardId: "a", waitId: "b.c" },
      "prose",
    );
    expect(a).not.toBe(b);
  });

  test("is held, unclaimed, until a person joins; the join posts it", async () => {
    const s = setup({ joined: false });
    intakeAttention(s.store, blocked());
    expect((await s.chat.postAttention(KEY)).status).toBe("held");
    expect(s.store.attentionEvent(KEY)).toBeNull();
    await s.deliver({
      type: "m.room.member",
      room_id: ROOM,
      state_key: ANA,
      sender: ANA,
      content: { membership: "join" },
    });
    expect(s.hs.sent).toHaveLength(1);
  });

  test("a failed send keeps its claim, and the retry is the same message", async () => {
    const s = setup();
    intakeAttention(s.store, blocked());
    s.hs.fail(true);
    expect((await s.chat.postAttention(KEY)).status).toBe("failed");
    expect(s.store.attentionEvent(KEY)?.postedAt).toBeNull();
    s.hs.fail(false);
    expect((await s.chat.postAttention(KEY)).status).toBe("posted");
    expect(s.hs.sent).toHaveLength(1);
  });
});

// ── attention.answer.v2 ─────────────────────────────────────────────────────

describe("attention.answer.v2", () => {
  test("resume here goes to the board as the person, with the instruction and the wait", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(attentionAnswer(ev));
    expect(s.board.calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/cards/crd_6b40/resume`,
        authorization: `Bearer ${jwt({ sub: "prn_ana" })}`,
        body: {
          comment: "The database is back; run the migrations again.",
          expectedWaitId: "wait_0123456789abcdef",
        },
      },
    ]);
    expect(s.said()).toEqual(["Resumed by Ana — the board has it."]);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toEqual([
      attentionOutcomeContent({ ...KEY, eventId: ev }, "resume_here", "Ana"),
    ]);
  });

  test("resume at an earlier stage names the stage; archive carries a remark when given, and nothing when not", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(
      attentionAnswer(ev, { option_id: "resume_at:plan", text: "Re-plan." }),
    );
    const ev2 = await s.wait(blocked({ waitId: "wait_2" }));
    await s.deliver(
      attentionAnswer(
        ev2,
        { wait_id: "wait_2", option_id: "archive", text: "Not needed." },
        { id: "$a2" },
      ),
    );
    const ev3 = await s.wait(blocked({ waitId: "wait_3" }));
    await s.deliver(
      attentionAnswer(
        ev3,
        { wait_id: "wait_3", option_id: "archive", text: undefined },
        { id: "$a3" },
      ),
    );
    expect(s.board.calls.map((c) => [c.path, c.body])).toEqual([
      [
        `/v1/boards/${BOARD}/cards/crd_6b40/resume`,
        {
          comment: "Re-plan.",
          toStageKey: "plan",
          expectedWaitId: "wait_0123456789abcdef",
        },
      ],
      [
        `/v1/boards/${BOARD}/cards/crd_6b40/archive`,
        { expectedWaitId: "wait_2", comment: "Not needed." },
      ],
      [
        `/v1/boards/${BOARD}/cards/crd_6b40/archive`,
        { expectedWaitId: "wait_3" },
      ],
    ]);
    expect(s.said()).toEqual([
      "Resumed (Resume at Plan) by Ana — the board has it.",
      "Archived by Ana — the board has it.",
      "Archived by Ana — the board has it.",
    ]);
  });

  test("a repeated answer leaves one receipt", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(attentionAnswer(ev), attentionAnswer(ev, {}, { id: "$2" }));
    expect(s.board.calls).toHaveLength(1);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toHaveLength(1);
  });

  test("a resume with no or a blank instruction, one past the board's limit, and a forward move are refused, said, never sent", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(
      attentionAnswer(ev, { text: undefined }, { id: "$1" }),
      attentionAnswer(ev, { text: "   " }, { id: "$2" }),
      attentionAnswer(ev, { text: "x".repeat(2731) }, { id: "$3" }),
      attentionAnswer(
        ev,
        { option_id: "archive", text: "x".repeat(2731) },
        { id: "$4" },
      ),
      attentionAnswer(ev, { option_id: "move_to:ship" }, { id: "$5" }),
      attentionAnswer(ev, { option_id: "resume_at:ship" }, { id: "$6" }),
    );
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([
      "Resuming needs an instruction for the next attempt. Nothing has changed.",
      "Resuming needs an instruction for the next attempt. Nothing has changed.",
      "That is longer than the board takes (at most 2730 characters). Nothing has changed.",
      "That is longer than the board takes (at most 2730 characters). Nothing has changed.",
      "That is not one of this card's choices. Nothing has changed.",
      "That is not one of this card's choices. Nothing has changed.",
    ]);
  });

  test("attribution refusals are silent: another reference, wait or room, unlinked, an agent", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(
      attentionAnswer(ev, {
        "m.relates_to": { rel_type: "m.reference", event_id: "$other" },
      }),
      attentionAnswer(ev, { wait_id: "wait_ffffffffffffffff" }, { id: "$b" }),
      attentionAnswer(ev, {}, { roomId: OTHER_ROOM, id: "$c" }),
      attentionAnswer(ev, {}, { sender: STRANGER, id: "$d" }),
      attentionAnswer(ev, {}, { sender: AGENT, id: "$e" }),
    );
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([]);
    expect(s.lines.some((l) => l.includes(`"agent" principal`))).toBe(true);
  });

  test("the plane down is said, and nothing is sent", async () => {
    const s = setup();
    const ev = await s.wait();
    s.plane.state.down = true;
    await s.deliver(attentionAnswer(ev));
    expect(s.board.calls).toHaveLength(0);
    expect(s.said()).toEqual([IDENTITY_UNAVAILABLE_TEXT]);
  });

  test("WAIT_CHANGED is said in plain words, and the card is closed with its outcome only", async () => {
    const s = setup();
    const ev = await s.wait();
    s.board.state.next = { status: 409, code: "WAIT_CHANGED" };
    await s.deliver(attentionAnswer(ev));
    expect(s.said()).toEqual([WAIT_CHANGED_TEXT]);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toEqual([
      attentionOutcomeContent(
        { ...KEY, eventId: ev },
        "settled_elsewhere",
        null,
      ),
    ]);
    s.board.state.next = { status: 200 };
    await s.deliver(attentionAnswer(ev, {}, { id: "$late" }));
    expect(s.board.calls).toHaveLength(1);
    expect(await s.chat.settleAttention(KEY)).toBe("already");
  });

  test("other board refusals are said, and the card stays open", async () => {
    const s = setup();
    const ev = await s.wait();
    s.board.state.next = { status: 403, code: "FORBIDDEN" };
    await s.deliver(attentionAnswer(ev));
    s.board.state.next = { status: 409, code: "SOMETHING_ELSE" };
    await s.deliver(attentionAnswer(ev, {}, { id: "$2" }));
    expect(s.said()).toEqual([
      "The board says you can't do that: it needs someone who may work this board. Nothing has changed.",
      "That did not go through (SOMETHING_ELSE). Nothing has changed.",
    ]);
    expect(s.store.attentionEvent(KEY)?.outcomePostedAt).toBeNull();
  });
});

// ── the sweeps ──────────────────────────────────────────────────────────────

function reading(pending: Record<string, unknown[] | Error>) {
  return async (boardId: string) => {
    const p = pending[boardId] ?? [];
    if (p instanceof Error) throw p;
    return p;
  };
}

describe("the follow-up sweep", () => {
  const sweep = (
    s: ReturnType<typeof setup>,
    pending: Record<string, unknown[] | Error>,
  ) =>
    sweepFollowups({
      store: s.store,
      board: { pendingFollowups: reading(pending) },
      chat: s.chat,
      log: (l) => s.lines.push(l),
    });

  test("posts a follow-up the relay never delivered, once", async () => {
    const s = setup();
    expect((await sweep(s, { [BOARD]: [owed()] })).projected).toBe(1);
    expect((await sweep(s, { [BOARD]: [owed()] })).projected).toBe(0);
    expect(s.hs.sent).toHaveLength(1);
  });

  test("settles a posted follow-up the board no longer lists, once, naming nobody", async () => {
    const s = setup();
    const ev = await s.owe();
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(1);
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(0);
    expect(s.said()).toEqual(["Settled on the board — the board has it."]);
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toEqual([
      deliveryOutcomeContent(
        "gate_8f3a",
        { boardId: BOARD, eventId: ev },
        "settled_elsewhere",
        null,
      ),
    ]);
  });

  test("a follow-up answered in chat is never settled after: one receipt", async () => {
    const s = setup();
    const ev = await s.owe();
    await s.deliver(deliveryAnswer(ev));
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(0);
    expect(await s.chat.settleFollowup("gate_8f3a")).toBe("already");
    expect(s.outcomes(GATE_OUTCOME_TYPE)).toHaveLength(1);
  });

  test("a settled follow-up takes no answer after", async () => {
    const s = setup();
    const ev = await s.owe();
    await sweep(s, { [BOARD]: [] });
    await s.deliver(deliveryAnswer(ev));
    expect(s.board.calls).toHaveLength(0);
  });

  test("a delivered follow-up never posted, and no longer listed, is never posted", async () => {
    const s = setup({ joined: false });
    intakeFollowup(s.store, owed());
    await s.chat.postFollowup("gate_8f3a");
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(1);
    s.store.recordMembership(ROOM, ANA, "join");
    await s.chat.postFollowup("gate_8f3a");
    expect(s.hs.sent).toHaveLength(0);
  });

  test("a board it could not read settles nothing, and the next board is still asked", async () => {
    const s = setup();
    await s.owe();
    const r = await sweep(s, {
      [BOARD]: new SuperpipelineError(401, "UNAUTHORIZED"),
      brd_other: [owed({ boardId: "brd_other", gateId: "gate_o" })],
    });
    expect(r.failedBoards).toBe(1);
    expect(r.projected).toBe(1);
    expect(s.store.followupEvent("gate_8f3a")?.outcomePostedAt).toBeNull();
    expect(s.lines.some((l) => l.includes("401 (UNAUTHORIZED)"))).toBe(true);
  });

  test("an entry it cannot read, but which names the gate, keeps the follow-up open", async () => {
    const s = setup();
    await s.owe();
    const r = await sweep(s, {
      [BOARD]: [{ gateId: "gate_8f3a", event: "delivery.pending" }],
    });
    expect(r.unreadable).toBe(1);
    expect(r.settled).toBe(0);
    expect(s.store.followupEvent("gate_8f3a")?.outcomePostedAt).toBeNull();
  });

  test("another board's follow-up in this board's list is not posted here", async () => {
    const s = setup();
    const r = await sweep(s, { [BOARD]: [owed({ boardId: "brd_other" })] });
    expect(r.unreadable).toBe(1);
    expect(s.hs.sent).toHaveLength(0);
  });
});

describe("the waiting-card sweep", () => {
  const sweep = (
    s: ReturnType<typeof setup>,
    pending: Record<string, unknown[] | Error>,
  ) =>
    sweepAttention({
      store: s.store,
      board: { pendingAttention: reading(pending) },
      chat: s.chat,
      log: (l) => s.lines.push(l),
    });

  test("posts a waiting card the relay never delivered, once", async () => {
    const s = setup();
    expect((await sweep(s, { [BOARD]: [blocked()] })).projected).toBe(1);
    expect((await sweep(s, { [BOARD]: [blocked()] })).projected).toBe(0);
    expect(s.hs.sent).toHaveLength(1);
  });

  test("closes the card whose wait ended, including one now waiting under a new wait", async () => {
    const s = setup();
    const ev = await s.wait();
    const again = blocked({ waitId: "wait_new" });
    const r = await sweep(s, { [BOARD]: [again] });
    expect(r.projected).toBe(1);
    expect(r.settled).toBe(1);
    expect(s.said()).toEqual([
      "This card is no longer waiting — it was settled on the board.",
    ]);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toEqual([
      attentionOutcomeContent(
        { ...KEY, eventId: ev },
        "settled_elsewhere",
        null,
      ),
    ]);
    expect(
      s.store.attentionEvent({ ...KEY, waitId: "wait_new" })?.postedAt,
    ).not.toBeNull();
    expect((await sweep(s, { [BOARD]: [again] })).settled).toBe(0);
  });

  test("a card answered in chat is never closed after: one receipt", async () => {
    const s = setup();
    const ev = await s.wait();
    await s.deliver(attentionAnswer(ev));
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(0);
    expect(s.outcomes(ATTENTION_OUTCOME_TYPE)).toHaveLength(1);
  });

  test("a delivered card never posted, and no longer listed, is never posted", async () => {
    const s = setup({ joined: false });
    intakeAttention(s.store, blocked());
    await s.chat.postAttention(KEY);
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(1);
    s.store.recordMembership(ROOM, ANA, "join");
    await s.chat.postAttention(KEY);
    expect(s.hs.sent).toHaveLength(0);
  });

  test("a board it could not read closes nothing, and the next board is still asked", async () => {
    const s = setup();
    await s.wait();
    const r = await sweep(s, {
      [BOARD]: new SuperpipelineError(403, "FORBIDDEN"),
      brd_other: [blocked({ boardId: "brd_other" })],
    });
    expect(r.failedBoards).toBe(1);
    expect(r.projected).toBe(1);
    expect(s.store.attentionEvent(KEY)?.outcomePostedAt).toBeNull();
  });

  test("an entry it cannot read, but which names the card and wait, keeps the card open", async () => {
    const s = setup();
    await s.wait();
    const r = await sweep(s, {
      [BOARD]: [
        {
          event: "attention.pending",
          cardId: KEY.cardId,
          waitId: KEY.waitId,
        },
      ],
    });
    expect(r.unreadable).toBe(1);
    expect(r.settled).toBe(0);
    expect(s.store.attentionEvent(KEY)?.outcomePostedAt).toBeNull();
  });

  test("another board's card in this board's list is not posted here", async () => {
    const s = setup();
    const r = await sweep(s, { [BOARD]: [blocked({ boardId: "brd_other" })] });
    expect(r.unreadable).toBe(1);
    expect(s.hs.sent).toHaveLength(0);
  });
});

// ── SuperPipeline ───────────────────────────────────────────────────────────

describe("SuperPipeline's follow-up and waiting-card routes", () => {
  test("pending follow-ups and waiting cards are read with this service's token; a body without the list is never empty", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    let body: unknown = { deliveries: [owed()], attention: [blocked()] };
    const reads = createSuperpipelineReads({
      baseUrl: `${SP_URL}/`,
      tokens: { get: async () => "svc-token", invalidate: () => undefined },
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({
          path: new URL(String(input)).pathname,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json(body);
      }) as typeof globalThis.fetch,
    });
    expect(await reads.pendingFollowups(BOARD)).toEqual([owed()]);
    expect(await reads.pendingAttention(BOARD)).toEqual([blocked()]);
    expect(calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/deliveries/pending`,
        authorization: "Bearer svc-token",
      },
      {
        path: `/v1/boards/${BOARD}/attention/pending`,
        authorization: "Bearer svc-token",
      },
    ]);
    body = { gates: [] };
    await expect(reads.pendingFollowups(BOARD)).rejects.toThrow(
      SuperpipelineError,
    );
    await expect(reads.pendingAttention(BOARD)).rejects.toThrow(
      SuperpipelineError,
    );
  });

  test("an answer the plane will not assert never reaches the board", async () => {
    const board = fakeBoard();
    const deps = {
      baseUrl: SP_URL,
      mint: async (): Promise<string> => {
        throw new AccountsError(403, "forbidden");
      },
      fetch: board.fetch,
    };
    const who = { principalId: "prn_ana", senderMxid: ANA };
    expect(
      await answerFollowupAtSuperpipeline(
        {
          boardId: BOARD,
          gateId: "gate_8f3a",
          change: { mode: "automatic" },
          ...who,
        },
        deps,
      ),
    ).toEqual({ ok: false, code: "ASSERTION_REFUSED" });
    expect(
      await answerAttentionAtSuperpipeline(
        { ...KEY, action: { kind: "archive", comment: null }, ...who },
        deps,
      ),
    ).toEqual({ ok: false, code: "ASSERTION_REFUSED" });
    expect(board.calls).toHaveLength(0);
  });
});

// ── treaty's corpus ─────────────────────────────────────────────────────────

type Case = {
  why: string;
  refusedBy: "schema" | "unique" | "recorded";
  body: Record<string, unknown>;
};
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

/**
 * The follow-ups the corpus answers, as this service would have recorded them when it posted
 * them: `gate_8f3a` on a complete preview, `gate_8f3b` on an incomplete one, both under the
 * message the corpus references.
 */
function recordFollowups(s: ReturnType<typeof setup>) {
  for (const [gateId, complete] of [
    ["gate_8f3a", true],
    ["gate_8f3b", false],
  ] as const) {
    s.store.claimFollowupEvent(gateId, BOARD, "crd_6b40", ROOM, {
      ...followupOffer(owed()),
      subjectPreviewComplete: complete,
    });
    s.store.recordFollowupPosted(gateId, "$deliveryEventId");
  }
}

/** The wait the corpus answers, recorded under the message it references. */
function recordWait(s: ReturnType<typeof setup>) {
  s.store.claimAttentionEvent(KEY, ROOM, attentionOffer(blocked()));
  s.store.recordAttentionPosted(KEY, "$attentionEventId");
}

async function reaches(
  record: (s: ReturnType<typeof setup>) => void,
  content: Record<string, unknown>,
): Promise<number> {
  const s = setup();
  record(s);
  await s.deliver({
    type: "m.room.message",
    room_id: ROOM,
    sender: ANA,
    event_id: "$corpus",
    content,
  });
  return s.board.calls.length;
}

for (const [type, record] of [
  [DELIVERY_ANSWER_V2_SUITE_TYPE, recordFollowups],
  [ATTENTION_ANSWER_V2_SUITE_TYPE, recordWait],
] as const) {
  describe(`treaty's corpus: ${type}`, () => {
    const cases = corpus.schemas[type] ?? { valid: {}, invalid: [] };
    test("has valid and invalid cases", () => {
      expect(Object.keys(cases.valid).length).toBeGreaterThan(0);
      expect(
        cases.invalid.filter((c) => c.refusedBy === "schema").length,
      ).toBeGreaterThan(0);
    });
    for (const [label, content] of Object.entries(cases.valid)) {
      test(`reaches the board once: ${label}`, async () => {
        expect(await reaches(record, content)).toBe(1);
      });
    }
    for (const c of cases.invalid) {
      test(`never reaches the board (${c.refusedBy}): ${c.why}`, async () => {
        expect(await reaches(record, c.body)).toBe(0);
      });
    }
  });
}

// ── what never reaches a log ────────────────────────────────────────────────

test("no secret, token or URL reaches a log on any path", async () => {
  const s = setup();
  const ev = await s.owe();
  const card = await s.wait();
  const done = await s.owe(owed({ gateId: "gate_done" }));
  const doneCard = await s.wait(blocked({ waitId: "wait_done" }));
  await s.deliver(
    deliveryAnswer(done, { gate_id: "gate_done" }, { id: "$ok1" }),
    attentionAnswer(doneCard, { wait_id: "wait_done" }, { id: "$ok2" }),
  );
  expect(s.board.calls).toHaveLength(2);
  s.board.state.next = "unreachable";
  await s.deliver(deliveryAnswer(ev), attentionAnswer(card));
  s.plane.state.down = true;
  await s.deliver(
    deliveryAnswer(ev, {}, { id: "$2" }),
    attentionAnswer(card, {}, { id: "$3" }),
  );
  s.hs.fail(true);
  for (const pending of [
    {},
    { [BOARD]: new SuperpipelineError(0, "unreachable") },
  ]) {
    await sweepFollowups({
      store: s.store,
      board: { pendingFollowups: reading(pending) },
      chat: s.chat,
      log: (l) => s.lines.push(l),
    });
    await sweepAttention({
      store: s.store,
      board: { pendingAttention: reading(pending) },
      chat: s.chat,
      log: (l) => s.lines.push(l),
    });
  }
  const everything = s.lines.join("\n");
  for (const secret of [
    CREDENTIAL.secret,
    CREDENTIAL.id,
    jwt({ sub: "prn_ana" }),
    PLANE_URL,
    SP_URL,
    AS_TOKEN,
    "ECONNREFUSED",
    "https://social.example/posts/1",
    "The database is back",
  ])
    expect(everything).not.toContain(secret);
});
