import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SIGNATURE_HEADER,
  signDelivery,
  toBinary,
} from "@superjackfruitlabs/treaty-cloudevents";
import {
  APPROVAL_REQUEST_NOTE,
  ELICITATION_REQUEST_CONTENT_KEY,
  QUESTION_ANSWER_V2_SUITE_TYPE,
  QUESTION_V2_SUITE_TYPE,
  boundedQuestion,
  elicitationRequestCard,
  questionV2Content,
  type ElicitationPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import { createClient, type MatrixEvent } from "../src/appservice/index.ts";
import {
  ALREADY_SETTLED_TEXT,
  APPROVAL_UNBOUND_TEXT,
  ELICITATION_PENDING_V1,
  IDENTITY_UNAVAILABLE_TEXT,
  QUESTION_CLOSED_TEXT,
  TYPED_APPROVAL_REFUSED_TEXT,
  SuperpipelineError,
  answerQuestionAtSuperpipeline,
  createAccounts,
  createApprovalScope,
  createBoardChat,
  createBoardRooms,
  createQuestionAnswers,
  createRoomSender,
  createSuperpipelineReads,
  intakeQuestion,
  matchReply,
  questionOffer,
  questionTxnId,
  sweepQuestions,
  type ApprovalRequestAllowed,
} from "../src/board-chat/index.ts";
import { createRelayHandler } from "../src/routes/relay.ts";
import type { QuestionOffer } from "../src/store/index.ts";
import { RELAY_SECRET, captureLog, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const SERVER = "staging-matrix.example.test";
const SPEAKER = `@superexchange_board:${SERVER}`;
const ANA = `@ana:${SERVER}`;
const AGENT = `@agent_cody:${SERVER}`;
const STRANGER = `@stranger:${SERVER}`;
const ROOM = `!board:${SERVER}`;
const OTHER_ROOM = `!other:${SERVER}`;
const BOARD = "brd_7c1f";
const AS_TOKEN = "as-token-for-tests";
const PLANE_URL = "http://accounts.test";
const SP_URL = "http://superpipeline.test";
const CREDENTIAL = {
  id: `svc_${"0b".repeat(10)}`,
  secret: "plane-secret-for-questions",
};
const NOW = new Date("2026-11-12T12:00:00.000Z");
const FUTURE = "2099-01-01T00:00:00.000Z";
const DIGEST = "sha256:4be1c0de9a7f30b2";

/** A JWT-shaped token; this service only reads its claims. */
function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(claims)}.signature`;
}

/** An agent's question as SuperPipeline publishes it. */
function questionBody(
  over: Partial<ElicitationPendingDelivery> = {},
): ElicitationPendingDelivery {
  return {
    event: "elicitation.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: "crd_51d0",
    cardTitle: "Upgrade the build image",
    elicitationId: "elc_1",
    runId: "run_12",
    stageKey: "build",
    agentId: "agt_31d0",
    question: "The tests need network access. May I run them?",
    options: [
      { id: "run_them", label: "Run the tests", meaning: "choose" },
      { id: "skip", label: "Skip them", meaning: "choose" },
      {
        id: "other",
        label: "Something else",
        meaning: "choose",
        input: { kind: "text", label: "What?", required: true },
      },
    ],
    ...over,
  } as ElicitationPendingDelivery;
}

/** A strict decision bound to a subject. */
function subjectQuestion(over: Partial<ElicitationPendingDelivery> = {}) {
  return questionBody({
    elicitationId: "elc_9b44",
    options: [
      { id: "approve", label: "Approve", meaning: "approve" },
      { id: "deny", label: "Deny", meaning: "reject" },
    ],
    approvalSubject: {
      id: "sub_1",
      digest: DIGEST,
      schema: "salaam-operation/v1",
      revision: 1,
      expiresAt: FUTURE,
      preview: [{ type: "field", label: "Run", value: "rm -rf build" }],
      previewComplete: true,
    },
    ...over,
  } as Partial<ElicitationPendingDelivery>);
}

/** A SuperToolkit approval request hosted on the board. */
function approvalRequest(over: Partial<ElicitationPendingDelivery> = {}) {
  return subjectQuestion({
    elicitationId: "apr_5d2e9c41",
    approvalRequestId: "apr_5d2e9c41",
    cardId: "",
    runId: "",
    stageKey: "",
    cardTitle: "Approval request",
    question: "Allow github issues.create on acme/site?",
    options: [
      {
        id: "allow_once",
        label: "Allow once",
        meaning: "approve",
        scope: "once",
        requires: "workspace-admin",
      },
      { id: "deny", label: "Deny", meaning: "reject", scope: "once" },
    ],
    approvalSubject: {
      id: "stkreq_8f2c",
      digest: DIGEST,
      schema: "stk-capability/v1",
      revision: 1,
      expiresAt: FUTURE,
      preview: [{ type: "field", label: "Capability", value: "issues.create" }],
      previewComplete: true,
    },
    ...over,
  } as Partial<ElicitationPendingDelivery>);
}

/** A homeserver for sends, joined_members and invites; a repeated transaction id is the first event. */
function fakeHomeserver() {
  const sent: Array<{
    roomId: string;
    type: string;
    txnId: string;
    content: Record<string, unknown>;
  }> = [];
  const txns = new Map<string, string>();
  const joined = new Map<string, string[]>();
  let failing = false;
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const joinedPath =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/.exec(path);
    if (joinedPath) {
      const members = joined.get(joinedPath[1] as string) ?? [SPEAKER];
      return Response.json({
        joined: Object.fromEntries(members.map((m) => [m, {}])),
      });
    }
    if (path.endsWith("/invite")) return Response.json({});
    const m =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/(.+)$/.exec(path);
    if (!m)
      return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
    if (failing)
      return Response.json({ errcode: "M_UNKNOWN" }, { status: 500 });
    const [, roomId, type, txnId] = m as unknown as string[];
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
  return {
    fetch,
    sent,
    joined,
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

/** The organization plane: Ana is a person, Cody an agent, the stranger nobody. */
function fakePlane() {
  const state = { down: false };
  const assertions: unknown[] = [];
  const identities: Record<string, string> = {
    [ANA]: "prn_ana",
    [AGENT]: "prn_cody",
  };
  const principals: Record<string, Record<string, unknown>> = {
    prn_ana: {
      id: "prn_ana",
      kind: "human",
      handle: "ana",
      displayName: "Ana",
    },
    prn_cody: { id: "prn_cody", kind: "agent", handle: "cody" },
  };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (state.down) throw new TypeError(`connect ECONNREFUSED ${PLANE_URL}`);
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const identity = /^\/api\/identities\/matrix\/(.+)$/.exec(path);
    if (identity) {
      const id = identities[identity[1] as string];
      return id
        ? Response.json({ principalId: id })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    const principal = /^\/api\/principals\/(.+)$/.exec(path);
    if (principal) {
      const p = principals[principal[1] as string];
      return p
        ? Response.json(p)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path === "/api/token/assertion") {
      const body = JSON.parse(String(init?.body)) as {
        identity: { externalId: string };
      };
      assertions.push(body);
      return Response.json({
        access_token: jwt({ sub: identities[body.identity.externalId] }),
        expires_in: 60,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, state, assertions, identities };
}

/** SuperPipeline's answer route; answers what `next` says. */
function fakeBoard() {
  const answers: Array<{
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const state: { next: { status: number; code?: string } | "unreachable" } = {
    next: { status: 200 },
  };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    answers.push({
      path: decodeURIComponent(new URL(String(input)).pathname),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = state.next;
    if (next === "unreachable") throw new TypeError("fetch failed");
    if (next.status === 200) return Response.json({ ok: true });
    return Response.json(
      { error: { code: next.code } },
      { status: next.status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, answers, state };
}

function setup({ joined = true }: { joined?: boolean } = {}) {
  const t = tempStore(() => NOW);
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
    plaintextRooms: true,
  });
  const accounts = createAccounts({
    url: PLANE_URL,
    credential: CREDENTIAL,
    fetch: plane.fetch,
  });
  const questions = createQuestionAnswers({
    store,
    client: sender,
    speaker: rooms.speaker,
    accounts,
    answerQuestion: (input) =>
      answerQuestionAtSuperpipeline(input, {
        baseUrl: SP_URL,
        mint: (subject) => accounts.assert({ ...subject, audience: SP_URL }),
        fetch: board.fetch,
      }),
    log,
    now: () => NOW,
  });
  const chat = createBoardChat({
    store,
    sender,
    rooms,
    crypto: null,
    questions,
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

  /** Deliver and post a question, as the relay would; answers its message's event id. */
  async function ask(body: ElicitationPendingDelivery): Promise<string> {
    await intakeQuestion(store, body, async () => true);
    const out = await chat.postQuestion(body.elicitationId);
    if (out.status !== "posted") throw new Error(`not posted: ${out.status}`);
    return out.eventId;
  }

  /** Hand the homeserver's events to board chat and wait for every answer to be carried. */
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

  return { store, hs, plane, board, chat, lines, ask, deliver, said };
}

/** A question.answer.v2 as a client sends it. */
function v2Answer(
  questionEventId: string,
  over: Record<string, unknown> = {},
  { sender = ANA, roomId = ROOM, eventId = "$answer1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: eventId,
    content: {
      msgtype: "m.text",
      body: "Run the tests",
      schema_version: 1,
      suite_event_type: QUESTION_ANSWER_V2_SUITE_TYPE,
      elicitation_id: "elc_1",
      option_id: "run_them",
      "m.relates_to": { rel_type: "m.reference", event_id: questionEventId },
      ...over,
    },
  };
}

/** A typed reply. */
function typed(
  body: string,
  { sender = ANA, roomId = ROOM, eventId = "$typed1" } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    room_id: roomId,
    sender,
    event_id: eventId,
    content: { msgtype: "m.text", body },
  };
}

// ── intake ──────────────────────────────────────────────────────────────────

describe("the relay's elicitation.pending", () => {
  const UTF8 = new TextEncoder();
  async function delivery(data: unknown, type = ELICITATION_PENDING_V1) {
    const body = UTF8.encode(JSON.stringify(data));
    const message = toBinary(
      {
        attributes: {
          id: "evt-q",
          source: "superpipeline",
          specversion: "1.0",
          type,
          datacontenttype: "application/json",
        },
        data: body,
      },
      "http",
    );
    return new Request("http://exchange/v1/relay/events", {
      method: "POST",
      headers: {
        ...message.headers,
        [SIGNATURE_HEADER]: await signDelivery(
          RELAY_SECRET,
          "evt-q",
          body,
          Date.now(),
        ),
      },
      body: body as BodyInit,
    });
  }
  function relay(approvalRequestAllowed?: ApprovalRequestAllowed) {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const accepted: string[] = [];
    const { log, lines } = captureLog();
    const handle = createRelayHandler({
      secret: RELAY_SECRET,
      store: t.store,
      log,
      onQuestionAccepted: (id) => accepted.push(id),
      ...(approvalRequestAllowed ? { approvalRequestAllowed } : {}),
    });
    t.store.upsertBoard({
      boardId: BOARD,
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [ANA],
    });
    return { handle, store: t.store, accepted, lines };
  }

  test("is the catalogue's CloudEvents type", () => {
    expect(ELICITATION_PENDING_V1).toBe(
      "com.superjackfruit.superpipeline.elicitation.pending.v1",
    );
  });

  test("an opted-in board's question is recorded once and handed on, a redelivery too", async () => {
    const r = relay();
    for (let i = 0; i < 2; i++) {
      const res = await r.handle(await delivery(questionBody()));
      expect(await res.json()).toEqual({ status: "accepted" });
    }
    expect(r.accepted).toEqual(["elc_1", "elc_1"]);
    expect(r.store.questionDelivery("elc_1")?.boardId).toBe(BOARD);
    expect(r.store.unpostedQuestions()).toHaveLength(1);
  });

  test("another board's, or a disabled board's, is ignored and recorded nowhere", async () => {
    const r = relay();
    const other = await r.handle(
      await delivery(questionBody({ boardId: "brd_x" })),
    );
    expect(await other.json()).toEqual({ status: "ignored" });
    r.store.disableBoard(BOARD);
    const disabled = await r.handle(await delivery(questionBody()));
    expect(await disabled.json()).toEqual({ status: "ignored" });
    expect(r.store.unpostedQuestions()).toHaveLength(0);
    expect(r.accepted).toEqual([]);
  });

  test("a body that is not a question is 400", async () => {
    const r = relay();
    const res = await r.handle(
      await delivery({ ...questionBody(), elicitationId: "" }),
    );
    expect(res.status).toBe(400);
    const gate = await r.handle(await delivery({ event: "gate.pending" }));
    expect(gate.status).toBe(400);
  });

  test("an approval request is kept only when the board is in this service's workspace", async () => {
    const none = relay();
    const res = await none.handle(await delivery(approvalRequest()));
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(none.store.questionDelivery("apr_5d2e9c41")).toBeNull();

    const asked: string[] = [];
    const refusing = relay(async (b) => {
      asked.push(b.orgId);
      return false;
    });
    expect(
      await (await refusing.handle(await delivery(approvalRequest()))).json(),
    ).toEqual({
      status: "ignored",
    });
    expect(asked).toEqual(["org_1"]);
    expect(refusing.store.questionDelivery("apr_5d2e9c41")).toBeNull();

    const allowing = relay(async () => true);
    expect(
      await (await allowing.handle(await delivery(approvalRequest()))).json(),
    ).toEqual({
      status: "accepted",
    });
    expect(allowing.accepted).toEqual(["apr_5d2e9c41"]);
  });

  test("an ordinary question never asks the approval-request rule", async () => {
    let asked = 0;
    const r = relay(async () => {
      asked++;
      return false;
    });
    expect(
      await (await r.handle(await delivery(questionBody()))).json(),
    ).toEqual({
      status: "accepted",
    });
    expect(asked).toBe(0);
  });
});

describe("the approval-request rule", () => {
  test("is this service's token's workspace being the board's", async () => {
    const { log, lines } = captureLog();
    const token = jwt({ org: "org_1", sub: "prn_svc" });
    const allowed = createApprovalScope({
      tokens: { get: async () => token },
      log,
    });
    expect(await allowed({ boardId: BOARD, orgId: "org_1" })).toBe(true);
    expect(await allowed({ boardId: "brd_x", orgId: "org_2" })).toBe(false);
    expect(await allowed({ boardId: "brd_x", orgId: "org_2" })).toBe(false);
    // Logged once per board, never the token.
    expect(lines.filter((l) => l.includes("brd_x"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(token);
  });

  test("a token with no workspace, or none at all, allows nothing", async () => {
    const { log, lines } = captureLog();
    expect(
      await createApprovalScope({ tokens: { get: async () => jwt({}) }, log })({
        boardId: BOARD,
        orgId: "org_1",
      }),
    ).toBe(false);
    expect(
      await createApprovalScope({
        tokens: {
          get: async () => {
            throw new Error(`${CREDENTIAL.secret} at ${PLANE_URL}`);
          },
        },
        log,
      })({ boardId: BOARD, orgId: "org_1" }),
    ).toBe(false);
    expect(lines.join("\n")).not.toContain(CREDENTIAL.secret);
    expect(lines.join("\n")).not.toContain(PLANE_URL);
  });
});

// ── posting ─────────────────────────────────────────────────────────────────

describe("a question is posted into its board's room", () => {
  test("as one message: treaty's question.v2 carrying the v1 card, and what it offered recorded", async () => {
    const s = setup();
    const eventId = await s.ask(questionBody());
    expect(s.hs.sent).toHaveLength(1);
    const [msg] = s.hs.sent;
    const d = boundedQuestion(questionBody());
    expect(msg?.type).toBe("m.room.message");
    expect(msg?.txnId).toBe(questionTxnId("elc_1", "prose"));
    expect(msg?.content).toEqual({
      ...questionV2Content(d),
      [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d),
    });
    expect(msg?.content.suite_event_type).toBe(QUESTION_V2_SUITE_TYPE);
    const q = s.store.questionEvent("elc_1");
    expect(q?.eventId).toBe(eventId);
    expect(q?.roomId).toBe(ROOM);
    expect(q?.offer).toEqual(questionOffer(d));
    expect(q?.offer.options.map((o) => o.id)).toEqual([
      "run_them",
      "skip",
      "other",
    ]);
  });

  test("a subject-bound question records its binding, preview and expiry", async () => {
    const s = setup();
    await s.ask(subjectQuestion());
    expect(s.store.questionEvent("elc_9b44")?.offer.subject).toEqual({
      id: "sub_1",
      digest: DIGEST,
      previewComplete: true,
      expiresAt: FUTURE,
    });
  });

  test("a question with no options records its free-text limit", async () => {
    const s = setup();
    await s.ask(questionBody({ options: [], freeText: { maxLength: 300 } }));
    expect(s.store.questionEvent("elc_1")?.offer.freeTextMaxLength).toBe(300);
  });

  test("is posted once, however often it is offered", async () => {
    const s = setup();
    await s.ask(questionBody());
    expect((await s.chat.postQuestion("elc_1")).status).toBe("already");
    s.chat.questionAccepted("elc_1");
    await s.chat.idle();
    expect(s.hs.sent).toHaveLength(1);
  });

  test("is held, unclaimed, until a person joins; the join posts it", async () => {
    const s = setup({ joined: false });
    await intakeQuestion(s.store, questionBody());
    expect((await s.chat.postQuestion("elc_1")).status).toBe("held");
    expect(s.store.questionEvent("elc_1")).toBeNull();
    expect(s.hs.sent).toHaveLength(0);
    await s.deliver({
      type: "m.room.member",
      room_id: ROOM,
      state_key: ANA,
      sender: ANA,
      content: { membership: "join" },
    });
    expect(s.hs.sent).toHaveLength(1);
    expect(s.store.questionEvent("elc_1")?.postedAt).not.toBeNull();
  });

  test("a failed send keeps its claim, and the retry is the same message", async () => {
    const s = setup();
    await intakeQuestion(s.store, questionBody());
    s.hs.fail(true);
    expect(await s.chat.postQuestion("elc_1")).toEqual({
      status: "failed",
      step: "send",
    });
    expect(s.store.questionEvent("elc_1")?.postedAt).toBeNull();
    s.hs.fail(false);
    expect((await s.chat.postQuestion("elc_1")).status).toBe("posted");
    await s.chat.postQuestion("elc_1");
    expect(s.hs.sent).toHaveLength(1);
  });

  test("a question the board stopped waiting on before it was posted is never posted", async () => {
    const s = setup({ joined: false });
    await intakeQuestion(s.store, questionBody());
    expect(await s.chat.settleQuestion("elc_1")).toBe("withdrawn");
    s.store.recordMembership(ROOM, ANA, "join");
    expect(await s.chat.postQuestion("elc_1")).toEqual({
      status: "skipped",
      reason: "settled",
    });
    expect(s.hs.sent).toHaveLength(0);
  });

  test("a room made in plaintext is not posted into while plaintext rooms are off", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const hs = fakeHomeserver();
    const { log } = captureLog();
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
      encryptNewRooms: true,
      log,
    });
    const chat = createBoardChat({
      store: t.store,
      sender: createRoomSender({
        store: t.store,
        client,
        crypto: null,
        plaintextRooms: false,
      }),
      rooms,
      crypto: null,
      log,
    });
    t.store.upsertBoard({
      boardId: BOARD,
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: [],
    });
    t.store.recordBoardRoom(BOARD, ROOM, "a", false);
    t.store.recordMembership(ROOM, ANA, "join");
    await intakeQuestion(t.store, questionBody());
    expect(await chat.postQuestion("elc_1")).toEqual({
      status: "refused",
      reason: "plaintext room",
    });
    expect(hs.sent).toHaveLength(0);
    expect(t.store.questionEvent("elc_1")).toBeNull();
  });

  test("an approval request names no card and links nowhere", async () => {
    const s = setup();
    await s.ask(approvalRequest());
    const content = s.hs.sent[0]?.content ?? {};
    expect(String(content.body)).toContain(APPROVAL_REQUEST_NOTE);
    expect(JSON.stringify(content)).not.toContain("deep_link");
    expect(s.store.questionEvent("apr_5d2e9c41")?.offer.approvalRequest).toBe(
      true,
    );
  });
});

// ── question.answer.v2 ──────────────────────────────────────────────────────

describe("question.answer.v2", () => {
  test("an offered option reaches the board once, as the person, and one receipt is posted", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(v2Answer(ev));
    expect(s.board.answers).toHaveLength(1);
    const [a] = s.board.answers;
    expect(a?.path).toBe(`/v1/boards/${BOARD}/elicitations/elc_1/answer`);
    expect(a?.body).toEqual({ option: "run_them" });
    expect(a?.authorization).toBe(`Bearer ${jwt({ sub: "prn_ana" })}`);
    expect(s.plane.assertions).toEqual([
      { identity: { system: "matrix", externalId: ANA }, audience: SP_URL },
    ]);
    expect(s.said()).toEqual([
      "Answered: Run the tests. The agent is unblocked.",
    ]);
    const receipt = s.hs.sent.at(-1);
    expect(receipt?.txnId).toBe(questionTxnId("elc_1", "outcome"));
    expect(s.store.questionEvent("elc_1")?.outcomePostedAt).not.toBeNull();
  });

  test("once answered, a second answer never reaches the board and nothing more is said", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(v2Answer(ev));
    await s.deliver(
      v2Answer(ev, { option_id: "skip" }, { eventId: "$answer2" }),
    );
    expect(s.board.answers).toHaveLength(1);
    expect(s.said()).toHaveLength(1);
  });

  test("a free-text answer and an option's input pass text", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(
      v2Answer(ev, { option_id: "other", text: "  only the unit tests " }),
    );
    expect(s.board.answers[0]?.body).toEqual({
      option: "other",
      text: "only the unit tests",
    });

    const f = setup();
    const fev = await f.ask(questionBody({ options: [] }));
    await f.deliver(v2Answer(fev, { option_id: undefined, text: "main" }));
    expect(f.board.answers[0]?.body).toEqual({ text: "main" });
    expect(f.said()).toEqual(["Answered. The agent is unblocked."]);
  });

  test("an option the question did not offer, an empty input, text alone and too much text are refused and said", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { option_id: "ship_it" },
        "That is not one of this question's options. Nothing has changed.",
      ],
      [
        { option_id: "other" },
        "That answer needs some text. Nothing has changed.",
      ],
      [
        { option_id: undefined, text: "yes" },
        "That is not one of this question's options. Nothing has changed.",
      ],
    ];
    for (const [over, text] of cases) {
      const s = setup();
      const ev = await s.ask(questionBody());
      await s.deliver(v2Answer(ev, over));
      expect(s.board.answers).toHaveLength(0);
      expect(s.said()).toEqual([text]);
    }
    const f = setup();
    const fev = await f.ask(
      questionBody({ options: [], freeText: { maxLength: 5 } }),
    );
    await f.deliver(v2Answer(fev, { option_id: undefined, text: "too long" }));
    expect(f.board.answers).toHaveLength(0);
    expect(f.said()[0]).toContain("at most 5 characters");
  });

  test("a reference to another message, an answer from another room, or a question never posted is refused silently", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(
      v2Answer("$someOther"),
      v2Answer(ev, {}, { roomId: OTHER_ROOM, eventId: "$a2" }),
      v2Answer(ev, { elicitation_id: "elc_never" }, { eventId: "$a3" }),
    );
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([]);
  });

  test("an unlinked sender and this service's own namespace are refused silently", async () => {
    const s = setup();
    // Linked, even: a sender in this namespace is this service, never a person answering.
    s.plane.identities[`@superexchange_x:${SERVER}`] = "prn_ana";
    const ev = await s.ask(questionBody());
    await s.deliver(
      v2Answer(ev, {}, { sender: STRANGER }),
      v2Answer(
        ev,
        {},
        { sender: `@superexchange_x:${SERVER}`, eventId: "$a2" },
      ),
    );
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([]);
  });

  test("a board no longer opted in is not answered for", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    s.store.disableBoard(BOARD);
    await s.deliver(v2Answer(ev));
    expect(s.board.answers).toHaveLength(0);
  });

  test("the plane down is said, and nothing reaches the board", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    s.plane.state.down = true;
    await s.deliver(v2Answer(ev));
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([IDENTITY_UNAVAILABLE_TEXT]);
    expect(s.lines.join("\n")).not.toContain("ECONNREFUSED");
  });

  test("a board that says the question is over is told once; the next answer says nothing", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    s.board.state.next = { status: 409, code: "ELICITATION_NOT_PENDING" };
    await s.deliver(v2Answer(ev));
    expect(s.said()).toEqual([ALREADY_SETTLED_TEXT]);
    expect(s.store.questionEvent("elc_1")?.outcomePostedAt).not.toBeNull();
  });

  test("any other refusal is said, and leaves the question open", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    s.board.state.next = { status: 403, code: "SEPARATION_OF_DUTIES" };
    await s.deliver(v2Answer(ev));
    s.board.state.next = "unreachable";
    await s.deliver(v2Answer(ev, {}, { eventId: "$a2" }));
    expect(s.said()).toEqual([
      "Whoever made a request can't also decide it. Someone else has to answer. Nothing has changed.",
      "That did not go through (UNREACHABLE). Nothing has changed.",
    ]);
    expect(s.store.questionEvent("elc_1")?.outcomePostedAt).toBeNull();
  });
});

describe("a subject-bound question", () => {
  const bound = { id: "sub_1", digest: DIGEST };
  async function answer(over: Record<string, unknown>, q = subjectQuestion()) {
    const s = setup();
    const ev = await s.ask(q);
    await s.deliver(v2Answer(ev, { elicitation_id: q.elicitationId, ...over }));
    return s;
  }

  test("an approval carrying the recorded binding reaches the board with it", async () => {
    const s = await answer({ option_id: "approve", subject: bound });
    expect(s.board.answers[0]?.body).toEqual({
      option: "approve",
      subject: bound,
    });
  });

  test("an answer without the binding, or with another one, is refused and said", async () => {
    for (const subject of [
      undefined,
      { ...bound, digest: "sha256:0" },
      { ...bound, id: "other" },
    ]) {
      const s = await answer({ option_id: "deny", subject });
      expect(s.board.answers).toHaveLength(0);
      expect(s.said()).toHaveLength(1);
    }
  });

  test("after the subject expired, even a decline is refused", async () => {
    const q = subjectQuestion();
    (q.approvalSubject as Record<string, unknown>).expiresAt =
      "2026-11-12T11:00:00.000Z";
    const s = await answer({ option_id: "deny", subject: bound }, q);
    expect(s.board.answers).toHaveLength(0);
  });

  test("on an incomplete preview an approval is refused and a decline goes on", async () => {
    const q = () => {
      const d = subjectQuestion();
      (d.approvalSubject as Record<string, unknown>).previewComplete = false;
      return d;
    };
    expect(
      (await answer({ option_id: "approve", subject: bound }, q())).board
        .answers,
    ).toHaveLength(0);
    expect(
      (await answer({ option_id: "deny", subject: bound }, q())).board.answers,
    ).toHaveLength(1);
  });

  test("a typed reply never approves it; a typed decline goes bound to the recorded version", async () => {
    for (const reply of ["1", "Approve", "approve"]) {
      const s = setup();
      await s.ask(subjectQuestion());
      await s.deliver(typed(reply));
      expect(s.board.answers).toHaveLength(0);
      expect(s.said()).toEqual([TYPED_APPROVAL_REFUSED_TEXT]);
    }
    const s = setup();
    await s.ask(subjectQuestion());
    await s.deliver(typed("2"));
    expect(s.board.answers[0]?.body).toEqual({
      option: "deny",
      subject: bound,
    });
  });
});

describe("an approval request", () => {
  const bound = { id: "stkreq_8f2c", digest: DIGEST };

  test("allow once reaches the board bound, and the receipt says SuperToolkit has it", async () => {
    const s = setup();
    const ev = await s.ask(approvalRequest());
    await s.deliver(
      v2Answer(ev, {
        elicitation_id: "apr_5d2e9c41",
        option_id: "allow_once",
        subject: bound,
      }),
    );
    expect(s.board.answers[0]?.path).toBe(
      `/v1/boards/${BOARD}/elicitations/apr_5d2e9c41/answer`,
    );
    expect(s.said()).toEqual([
      "Answered: Allow once. SuperToolkit has the decision.",
    ]);
  });

  test("only a person answers it: another agent, even a bound deny or a typed one, is refused quietly", async () => {
    const s = setup();
    const ev = await s.ask(approvalRequest());
    await s.deliver(
      v2Answer(
        ev,
        { elicitation_id: "apr_5d2e9c41", option_id: "deny", subject: bound },
        { sender: AGENT },
      ),
      typed("2", { sender: AGENT, eventId: "$t2" }),
    );
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([]);
  });

  test("an agent's answer to an ordinary question is still the board's to judge", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(v2Answer(ev, {}, { sender: AGENT }));
    expect(s.board.answers).toHaveLength(1);
  });

  test("the board's refusals are said in plain words", async () => {
    const s = setup();
    const ev = await s.ask(approvalRequest());
    s.board.state.next = { status: 403, code: "WORKSPACE_ADMIN_REQUIRED" };
    await s.deliver(
      v2Answer(ev, {
        elicitation_id: "apr_5d2e9c41",
        option_id: "allow_once",
        subject: bound,
      }),
    );
    expect(s.said()).toEqual([
      "Only workspace owners and admins can allow this. Nothing has changed.",
    ]);
  });

  test("one with no subject that could be carried is never allowed from a room", async () => {
    const s = setup();
    const ev = await s.ask(approvalRequest({ approvalSubject: undefined }));
    // treaty withholds allow_once from what was posted; an approve is refused here besides.
    expect(
      s.store.questionEvent("apr_5d2e9c41")?.offer.options.map((o) => o.id),
    ).toEqual(["deny"]);
    await s.deliver(
      v2Answer(ev, { elicitation_id: "apr_5d2e9c41", option_id: "allow_once" }),
    );
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([
      "That is not one of this question's options. Nothing has changed.",
    ]);
  });

  test("an approve recorded on an unbound approval request is refused with its own words", async () => {
    const s = setup();
    const offer: QuestionOffer = {
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
      optionsV2: [
        {
          id: "allow_once",
          label: "Allow once",
          meaning: "approve",
          needs_comment: false,
        },
        { id: "deny", label: "Deny", meaning: "reject", needs_comment: false },
      ],
      freeTextMaxLength: null,
      subject: null,
      approvalRequest: true,
    };
    s.store.claimQuestionEvent("apr_x", BOARD, ROOM, offer);
    s.store.recordQuestionPosted("apr_x", "$apr");
    await s.deliver(
      v2Answer("$apr", { elicitation_id: "apr_x", option_id: "allow_once" }),
    );
    await s.deliver(typed("1", { eventId: "$t1" }));
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([APPROVAL_UNBOUND_TEXT, APPROVAL_UNBOUND_TEXT]);
    await s.deliver(typed("deny", { eventId: "$t2" }));
    expect(s.board.answers[0]?.body).toEqual({ option: "deny" });
  });
});

// ── typed replies ───────────────────────────────────────────────────────────

describe("a typed reply", () => {
  test("a number, a label or an id answers the open question", async () => {
    for (const [reply, option] of [
      ["2", "skip"],
      ["  run the TESTS ", "run_them"],
      ["skip", "skip"],
    ] as const) {
      const s = setup();
      await s.ask(questionBody());
      await s.deliver(typed(reply));
      expect(s.board.answers.map((a) => a.body)).toEqual([{ option }]);
    }
  });

  test("says nothing in a room with no open question, or once it is answered", async () => {
    const s = setup();
    await s.deliver(typed("2"));
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([]);
    await s.ask(questionBody());
    await s.deliver(typed("2", { eventId: "$t2" }));
    await s.deliver(typed("1", { eventId: "$t3" }));
    expect(s.board.answers).toHaveLength(1);
  });

  test("an unmatched reply gives a person the options again, and a stranger or an agent nothing", async () => {
    const s = setup();
    await s.ask(questionBody());
    await s.deliver(typed("yes"));
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([
      "That is not one of the options, so nothing has been approved.\n\n1. Run the tests\n2. Skip them\n3. Something else\n\nReply with the number, or the option's name.",
    ]);
    await s.deliver(
      typed("yes", { sender: STRANGER, eventId: "$t2" }),
      typed("ok", { sender: AGENT, eventId: "$t3" }),
    );
    expect(s.said()).toHaveLength(1);
  });

  test("a question with no options is not answered by typing", async () => {
    const s = setup();
    await s.ask(questionBody({ options: [] }));
    await s.deliver(typed("main"));
    expect(s.board.answers).toHaveLength(0);
    expect(s.said()).toEqual([]);
  });

  test("goes to the agent's question, not a newer approval request; alone, the request takes a deny", async () => {
    const s = setup();
    await s.ask(questionBody());
    await s.ask(approvalRequest());
    await s.deliver(typed("2"));
    expect(s.board.answers[0]?.path).toContain("/elicitations/elc_1/answer");
    await s.deliver(typed("deny", { eventId: "$t2" }));
    expect(s.board.answers[1]?.path).toContain(
      "/elicitations/apr_5d2e9c41/answer",
    );
    expect(s.board.answers[1]?.body).toEqual({
      option: "deny",
      subject: { id: "stkreq_8f2c", digest: DIGEST },
    });
  });

  test("a message carrying any structured envelope is never read as a typed reply", async () => {
    const s = setup();
    await s.ask(questionBody());
    await s.deliver({
      ...typed("1"),
      content: {
        msgtype: "m.text",
        body: "1",
        suite_event_type: "dev.superpipeline.delivery.answer.v2",
      },
    });
    await s.deliver({
      ...typed("1"),
      event_id: "$n",
      content: { msgtype: "m.notice", body: "1" },
    });
    expect(s.board.answers).toHaveLength(0);
  });

  test("the match is plain: nothing that merely resembles agreement", () => {
    const options = [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_always", label: "Allow always" },
    ];
    expect(matchReply("yes", options)).toBeNull();
    expect(matchReply("allow", options)).toBeNull();
    expect(matchReply("3", options)).toBeNull();
    expect(matchReply("0", options)).toBeNull();
    expect(matchReply("2", options)).toBe("allow_always");
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

describe("the question sweep", () => {
  function sweep(
    s: ReturnType<typeof setup>,
    pending: Record<string, unknown[] | Error>,
    approvalRequestAllowed: ApprovalRequestAllowed = async () => true,
  ) {
    return sweepQuestions({
      store: s.store,
      board: {
        pendingQuestions: async (boardId) => {
          const p = pending[boardId] ?? [];
          if (p instanceof Error) throw p;
          return p;
        },
      },
      chat: s.chat,
      approvalRequestAllowed,
      log: (line) => s.lines.push(line),
    });
  }

  test("posts a question the relay never delivered", async () => {
    const s = setup();
    const r = await sweep(s, { [BOARD]: [questionBody()] });
    expect(r.projected).toBe(1);
    expect(s.hs.sent).toHaveLength(1);
    const again = await sweep(s, { [BOARD]: [questionBody()] });
    expect(again.projected).toBe(0);
    expect(s.hs.sent).toHaveLength(1);
  });

  test("an approval request it finds obeys the same rule", async () => {
    const s = setup();
    await sweep(s, { [BOARD]: [approvalRequest()] }, async () => false);
    expect(s.store.questionDelivery("apr_5d2e9c41")).toBeNull();
    expect(s.hs.sent).toHaveLength(0);
  });

  test("closes a posted question the board no longer lists, once", async () => {
    const s = setup();
    await s.ask(questionBody());
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(1);
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(0);
    expect(s.said()).toEqual([QUESTION_CLOSED_TEXT]);
    expect(s.hs.sent.at(-1)?.txnId).toBe(questionTxnId("elc_1", "outcome"));
  });

  test("leaves a question the board still lists alone, and an answered one is not closed again", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    expect((await sweep(s, { [BOARD]: [questionBody()] })).settled).toBe(0);
    await s.deliver(v2Answer(ev));
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(0);
    expect(s.said()).toEqual([
      "Answered: Run the tests. The agent is unblocked.",
    ]);
  });

  test("a question answered in chat is never closed after: one receipt", async () => {
    const s = setup();
    const ev = await s.ask(questionBody());
    await s.deliver(v2Answer(ev));
    expect(await s.chat.settleQuestion("elc_1")).toBe("already");
    expect(s.said()).toEqual([
      "Answered: Run the tests. The agent is unblocked.",
    ]);
  });

  test("a delivered question never posted, and no longer listed, is never posted", async () => {
    const s = setup({ joined: false });
    await intakeQuestion(s.store, questionBody());
    await s.chat.postQuestion("elc_1");
    expect((await sweep(s, { [BOARD]: [] })).settled).toBe(1);
    s.store.recordMembership(ROOM, ANA, "join");
    await s.chat.postQuestion("elc_1");
    expect(s.hs.sent).toHaveLength(0);
  });

  test("a board it could not read closes nothing, and the next board is still asked", async () => {
    const s = setup();
    await s.ask(questionBody());
    const r = await sweep(s, {
      [BOARD]: new SuperpipelineError(403, "FORBIDDEN"),
      brd_other: [
        questionBody({ boardId: "brd_other", elicitationId: "elc_o" }),
      ],
    });
    expect(r.failedBoards).toBe(1);
    expect(r.projected).toBe(1);
    expect(s.store.questionEvent("elc_1")?.outcomePostedAt).toBeNull();
    expect(s.lines.some((l) => l.includes("403 (FORBIDDEN)"))).toBe(true);
  });

  test("an entry it cannot read, but which names a question, keeps that question open", async () => {
    const s = setup();
    await s.ask(questionBody());
    const r = await sweep(s, {
      [BOARD]: [{ elicitationId: "elc_1", event: "elicitation.pending" }],
    });
    expect(r.unreadable).toBe(1);
    expect(r.settled).toBe(0);
    expect(s.store.questionEvent("elc_1")?.outcomePostedAt).toBeNull();
  });

  test("another board's question in this board's list is not posted here", async () => {
    const s = setup();
    const r = await sweep(s, {
      [BOARD]: [questionBody({ boardId: "brd_other" })],
    });
    expect(r.unreadable).toBe(1);
    expect(s.hs.sent).toHaveLength(0);
  });
});

// ── SuperPipeline ───────────────────────────────────────────────────────────

describe("SuperPipeline's question routes", () => {
  test("pending questions are read with this service's token; a body without the list is never empty", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    let body: unknown = { elicitations: [questionBody()] };
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
    expect(await reads.pendingQuestions(BOARD)).toEqual([questionBody()]);
    expect(calls).toEqual([
      {
        path: `/v1/boards/${BOARD}/elicitations/pending`,
        authorization: "Bearer svc-token",
      },
    ]);
    body = { gates: [] };
    await expect(reads.pendingQuestions(BOARD)).rejects.toThrow(
      SuperpipelineError,
    );
  });

  test("a refused read throws and drops the token on 401", async () => {
    let dropped = 0;
    const reads = createSuperpipelineReads({
      baseUrl: SP_URL,
      tokens: {
        get: async () => "svc-token",
        invalidate: () => void dropped++,
      },
      fetch: (async () =>
        Response.json(
          { error: { code: "UNAUTHORIZED" } },
          { status: 401 },
        )) as unknown as typeof globalThis.fetch,
    });
    await expect(reads.pendingQuestions(BOARD)).rejects.toThrow(
      "401 (UNAUTHORIZED)",
    );
    expect(dropped).toBe(1);
  });

  test("an answer the plane will not assert never reaches the board", async () => {
    const board = fakeBoard();
    const { AccountsError } = await import("../src/board-chat/index.ts");
    const result = await answerQuestionAtSuperpipeline(
      {
        boardId: BOARD,
        elicitationId: "elc_1",
        option: "skip",
        principalId: "prn_ana",
        senderMxid: ANA,
      },
      {
        baseUrl: SP_URL,
        mint: async () => {
          throw new AccountsError(403, "forbidden");
        },
        fetch: board.fetch,
      },
    );
    expect(result).toEqual({ ok: false, code: "ASSERTION_REFUSED" });
    expect(board.answers).toHaveLength(0);
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
 * What this service would have recorded when it posted the question an answer names: that id, in
 * this room, under the event the answer references, offering the option answered (with an input
 * when the answer carries text) and bound to the subject it names. Built from the answer, so a
 * refusal can only be the answer's own fault.
 */
function recordFor(content: Record<string, unknown>): {
  id: string;
  eventId: string;
  offer: QuestionOffer;
} {
  const id = String(content.elicitation_id);
  const option =
    typeof content.option_id === "string" ? content.option_id : null;
  const rel = content["m.relates_to"] as { event_id?: string } | undefined;
  const subject = content.subject as
    | { id?: string; digest?: string }
    | undefined;
  const meaning =
    option === "approve" || option === "allow_once"
      ? "approve"
      : option === "deny"
        ? "reject"
        : "choose";
  return {
    id,
    eventId:
      rel?.event_id ??
      (id.startsWith("apr_") ? "$aprEventId" : "$questionEventId"),
    offer: {
      options: option ? [{ id: option, label: option }] : [],
      optionsV2: option
        ? [
            {
              id: option,
              label: option,
              meaning,
              needs_comment: false,
              ...(typeof content.text === "string"
                ? {
                    input: {
                      kind: "text" as const,
                      required: true,
                      max_length: 2000,
                    },
                  }
                : {}),
            },
          ]
        : [],
      freeTextMaxLength: option ? null : 2000,
      subject:
        subject?.id && subject.digest
          ? {
              id: subject.id,
              digest: subject.digest,
              previewComplete: true,
              expiresAt: null,
            }
          : null,
      approvalRequest: id.startsWith("apr_"),
    },
  };
}

async function reaches(content: Record<string, unknown>): Promise<number> {
  const s = setup();
  const { id, eventId, offer } = recordFor(content);
  s.store.claimQuestionEvent(id, BOARD, ROOM, offer);
  s.store.recordQuestionPosted(id, eventId);
  await s.deliver({
    type: "m.room.message",
    room_id: ROOM,
    sender: ANA,
    event_id: "$corpus",
    content,
  });
  return s.board.answers.length;
}

describe(`treaty's corpus: ${QUESTION_ANSWER_V2_SUITE_TYPE}`, () => {
  const cases = corpus.schemas[QUESTION_ANSWER_V2_SUITE_TYPE] ?? {
    valid: {},
    invalid: [],
  };
  test("has valid and invalid cases", () => {
    expect(Object.keys(cases.valid).length).toBeGreaterThan(0);
    expect(
      cases.invalid.filter((c) => c.refusedBy !== "recorded").length,
    ).toBeGreaterThan(0);
  });
  for (const [label, content] of Object.entries(cases.valid)) {
    test(`reaches the board once: ${label}`, async () => {
      expect(await reaches(content)).toBe(1);
    });
  }
  for (const c of cases.invalid.filter((k) => k.refusedBy !== "recorded")) {
    test(`never reaches the board (${c.refusedBy}): ${c.why}`, async () => {
      expect(await reaches(c.body)).toBe(0);
    });
  }
});

// ── what never reaches a log ────────────────────────────────────────────────

test("no secret, token or URL reaches a log on any path", async () => {
  const s = setup();
  const ev = await s.ask(questionBody());
  s.board.state.next = "unreachable";
  await s.deliver(v2Answer(ev));
  s.plane.state.down = true;
  await s.deliver(
    v2Answer(ev, {}, { eventId: "$a2" }),
    typed("1", { eventId: "$t" }),
  );
  s.hs.fail(true);
  await sweepQuestions({
    store: s.store,
    board: { pendingQuestions: async () => [] },
    chat: s.chat,
    approvalRequestAllowed: async () => true,
    log: (l) => s.lines.push(l),
  });
  const everything = s.lines.join("\n");
  for (const secret of [
    CREDENTIAL.secret,
    CREDENTIAL.id,
    jwt({ sub: "prn_ana" }),
    PLANE_URL,
    SP_URL,
    AS_TOKEN,
    "ECONNREFUSED",
  ])
    expect(everything).not.toContain(secret);
});
