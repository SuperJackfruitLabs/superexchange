import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  GATE_OUTCOME_TYPE,
  gateOutcomeBody,
  gateOutcomeContent,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import { createClient, type MatrixEvent } from "../src/appservice/index.ts";
import {
  ALREADY_DECIDED_TEXT,
  IDENTITY_UNAVAILABLE_TEXT,
  LINK_HINT_TEXT,
  createAccounts,
  createBoardChat,
  createBoardRooms,
  createGateAnswers,
  createRoomSender,
  gateOffer,
  resolveGateAtSuperpipeline,
} from "../src/board-chat/index.ts";
import type { GateOffer } from "../src/store/index.ts";
import { captureLog, gateBody, tempStore } from "./helpers.ts";

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
const OTHER_ROOM = `!other-board:${SERVER}`;
const CARD = "$card";
const PROSE = "$prose";
const AS_TOKEN = "as-token-for-tests";
const PLANE_URL = "http://accounts.test";
const SP_URL = "http://superpipeline.test";
const CREDENTIAL = {
  id: `svc_${"0a".repeat(10)}`,
  secret: "plane-secret-for-tests",
};
const ANA_PRN = "prn_ana";

/** A JWT-shaped token whose payload names `sub`; SuperPipeline verifies it, this service only reads it. */
function token(sub: string): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part({ sub, aud: SP_URL })}.signature`;
}

interface Sent {
  roomId: string;
  type: string;
  txnId: string;
  content: Record<string, unknown>;
}

/** Only what answers need of a homeserver: send, answering a repeated transaction id with the first event. */
function fakeHomeserver() {
  const sent: Sent[] = [];
  /** Who each send was made as. */
  const senders: Array<string | null> = [];
  const txns = new Map<string, string>();
  let failing = false;
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const m =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/(.+)$/.exec(
        url.pathname,
      );
    if (!m)
      return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
    if (failing)
      return Response.json({ errcode: "M_UNKNOWN" }, { status: 500 });
    const [, roomId, type, txnId] = m.map((p) => decodeURIComponent(p));
    const key = `${url.searchParams.get("user_id")}|${txnId}`;
    const known = txns.get(key);
    if (known) return Response.json({ event_id: known });
    const eventId = `$sent${sent.length + 1}`;
    txns.set(key, eventId);
    senders.push(url.searchParams.get("user_id"));
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
    senders,
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

interface PlaneCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** The organization plane: Ana is a person, Cody an agent; the stranger is linked to nobody. */
function fakePlane() {
  const calls: PlaneCall[] = [];
  const state = {
    down: false,
    /** Who the plane asserts for a sender. */
    asserts: ANA_PRN,
    assertionStatus: 200,
  };
  const identities: Record<string, string> = {
    [ANA]: ANA_PRN,
    [AGENT]: "prn_cody",
  };
  const principals: Record<string, Record<string, unknown>> = {
    [ANA_PRN]: {
      id: ANA_PRN,
      kind: "human",
      handle: "ana",
      displayName: "Ana",
    },
    prn_cody: {
      id: "prn_cody",
      kind: "agent",
      handle: "cody",
      displayName: null,
    },
  };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path,
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (state.down) throw new TypeError(`connect ECONNREFUSED ${PLANE_URL}`);
    const identity = /^\/api\/identities\/matrix\/(.+)$/.exec(path);
    if (identity) {
      const id = identities[identity[1] as string];
      return id
        ? Response.json({ principalId: id, kind: "human", suspended: false })
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
      if (state.assertionStatus !== 200)
        return Response.json(
          { error: "refused" },
          { status: state.assertionStatus },
        );
      return Response.json({
        access_token: token(state.asserts),
        expires_in: 60,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    state,
    identities,
    principals,
    assertions: () => calls.filter((c) => c.path === "/api/token/assertion"),
  };
}

/** SuperPipeline's resolve route; answers what `next` says. */
function fakeBoard() {
  const resolves: Array<{
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const state: {
    next: { status: number; code?: string } | "unreachable";
  } = { next: { status: 200 } };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    resolves.push({
      path: decodeURIComponent(url.pathname),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = state.next;
    if (next === "unreachable") throw new TypeError("fetch failed");
    if (next.status === 200) return Response.json({ ok: true });
    if (next.code === undefined)
      return new Response("upstream error", { status: next.status });
    return Response.json(
      { error: { code: next.code ?? "X" } },
      { status: next.status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, resolves, state };
}

/** The default gate: a v1 gate with approve, request changes and reject, posted into ROOM. */
const GATE = gateBody({ gateId: "gte_1" }) as unknown as GatePendingDelivery;

function setup(o: { now?: () => Date } = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
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
    store: t.store,
    client,
    serverName: SERVER,
    encryptNewRooms: false,
    log,
  });
  const accounts = createAccounts({
    url: PLANE_URL,
    credential: CREDENTIAL,
    fetch: plane.fetch,
  });
  const answers = createGateAnswers({
    store: t.store,
    client,
    speaker: rooms.speaker,
    accounts,
    resolveGate: (input) =>
      resolveGateAtSuperpipeline(input, {
        baseUrl: SP_URL,
        mint: (subject) => accounts.assert({ ...subject, audience: SP_URL }),
        fetch: board.fetch,
      }),
    log,
    now: o.now ?? (() => new Date("2026-11-12T12:00:00.000Z")),
  });
  const chat = createBoardChat({
    store: t.store,
    sender: createRoomSender({
      store: t.store,
      client,
      crypto: null,
      plaintextRooms: true,
    }),
    rooms,
    crypto: null,
    answers,
    log,
  });
  const store = t.store;
  store.upsertBoard({
    boardId: "brd_7c1f",
    spTenantId: "tnt_1",
    orgId: "org_1",
    invitees: [ANA],
  });
  store.upsertBoard({
    boardId: "brd_other",
    spTenantId: "tnt_1",
    orgId: "org_1",
    invitees: [ANA],
  });
  store.recordBoardRoom(
    "brd_7c1f",
    ROOM,
    "superexchange_board_brd_7c1f",
    false,
  );
  store.recordBoardRoom(
    "brd_other",
    OTHER_ROOM,
    "superexchange_board_brd_other",
    false,
  );

  /** Record a gate as posted, with the offer given or the one its gate.v2 carries. */
  function posted(
    gateId = "gte_1",
    offer: GateOffer | null = gateOffer(GATE),
    { boardId = "brd_7c1f", roomId = ROOM, card = CARD, prose = PROSE } = {},
  ) {
    store.claimGateEvent(gateId, boardId, roomId, offer ?? undefined);
    store.recordGateProse(gateId, prose);
    store.recordGatePosted(gateId, card);
  }

  /** Hand the homeserver's events to board chat and wait for every answer to be carried. */
  async function deliver(...events: MatrixEvent[]) {
    await chat.onEvents("txn", events);
    await chat.idle();
  }

  return {
    store,
    hs,
    plane,
    board,
    chat,
    answers,
    lines,
    posted,
    deliver,
    /** Everything this service said in rooms. */
    said: () => hs.sent,
    replies: () =>
      hs.sent
        .filter((e) => e.type === "m.room.message")
        .map((e) => e.content.body),
  };
}

let eventCounter = 0;

/** A person's answer, as a client sends it. */
function answer(
  o: {
    gateId?: string;
    option?: string;
    version?: 1 | 2;
    ref?: string | null;
    sender?: string;
    room?: string;
    comment?: string | null;
    subject?: { id: string; digest: string };
    eventId?: string;
    relation?: Record<string, unknown>;
  } = {},
): MatrixEvent {
  const version = o.version ?? 1;
  const ref = o.ref === undefined ? CARD : o.ref;
  return {
    type: "m.room.message",
    room_id: o.room ?? ROOM,
    sender: o.sender ?? ANA,
    event_id: o.eventId ?? `$answer${++eventCounter}`,
    content: {
      msgtype: "m.text",
      body: "Approved",
      schema_version: 1,
      suite_event_type: `dev.superpipeline.gate.decision.v${version}`,
      gate_id: o.gateId ?? "gte_1",
      option_id: o.option ?? "approve",
      comment: o.comment ?? null,
      ...(o.subject ? { subject: o.subject } : {}),
      ...(o.relation
        ? { "m.relates_to": o.relation }
        : ref === null
          ? {}
          : { "m.relates_to": { rel_type: "m.reference", event_id: ref } }),
    },
  };
}

describe("a person's answer", () => {
  test("is resolved at SuperPipeline as that person, once, and one receipt is posted", async () => {
    const s = setup();
    s.posted();
    await s.deliver(answer());

    // Who the sender is, then an assertion for them, with this service's own credential.
    expect(s.plane.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/identities/matrix/${ANA}`,
      `GET /api/principals/${ANA_PRN}`,
      "POST /api/token/assertion",
    ]);
    for (const c of s.plane.calls)
      expect(c.authorization).toBe(
        `Bearer ${CREDENTIAL.id}:${CREDENTIAL.secret}`,
      );
    expect(s.plane.assertions()[0]?.body).toEqual({
      identity: { system: "matrix", externalId: ANA },
      audience: SP_URL,
    });

    // The board is asked as the person: their assertion, never this service's credential.
    expect(s.board.resolves).toEqual([
      {
        path: "/v1/boards/brd_7c1f/gates/gte_1/resolve",
        authorization: `Bearer ${token(ANA_PRN)}`,
        body: { decision: "approve" },
      },
    ]);

    // One receipt: the prose line and the outcome event pointing at the card, both treaty's.
    const decided = { decision: "approve", decidedBy: "Ana", chosen: null };
    expect(s.said()).toEqual([
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
          boardId: "brd_7c1f",
          gateEventId: CARD,
        }),
      },
    ]);
    expect(s.said()[0]?.content.body).toBe(
      "Approved by Ana — the board has it.",
    );
    expect(s.hs.senders).toEqual([SPEAKER, SPEAKER]);
    expect(s.store.gateEvent("gte_1")).toMatchObject({
      outcomeClaimedAt: expect.any(String),
      outcomePostedAt: expect.any(String),
    });
  });

  test("an answer to the prose is an answer to the gate, and carries its comment", async () => {
    const s = setup();
    s.posted();
    await s.deliver(
      answer({ ref: PROSE, option: "request_changes", comment: "Add a test." }),
    );
    expect(s.board.resolves.map((r) => r.body)).toEqual([
      { decision: "request_changes", comment: "Add a test." },
    ]);
    expect(s.replies()).toEqual([
      "Changes requested by Ana — the board has it.",
    ]);
  });

  test("a repeat answer acts once, and the repeat is told it was already decided", async () => {
    const s = setup();
    s.posted();
    await s.deliver(answer());
    await s.deliver(answer({ option: "reject" }));
    expect(s.board.resolves).toHaveLength(1);
    expect(s.said().filter((e) => e.type === GATE_OUTCOME_TYPE)).toHaveLength(
      1,
    );
    expect(s.replies()).toEqual([
      "Approved by Ana — the board has it.",
      ALREADY_DECIDED_TEXT,
    ]);
  });

  test("the same answer delivered twice in one transaction acts once", async () => {
    const s = setup();
    s.posted();
    const twice = answer({ eventId: "$same" });
    await s.deliver(twice, twice);
    expect(s.board.resolves).toHaveLength(1);
    expect(s.said().filter((e) => e.type === GATE_OUTCOME_TYPE)).toHaveLength(
      1,
    );
  });

  test("a receipt that cannot be posted leaves the gate resolved, and is not posted twice", async () => {
    const s = setup();
    s.posted();
    s.hs.fail(true);
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(1);
    expect(s.store.gateEvent("gte_1")?.outcomePostedAt).not.toBeNull();
    expect(s.lines.some((l) => l.includes("receipt could not be posted"))).toBe(
      true,
    );
  });

  test("a gate whose receipt was already posted gets no second one", async () => {
    const s = setup();
    s.posted();
    s.store.claimGateReceipt("gte_1");
    expect(await s.chat.answer(answer())).toEqual({ status: "resolved" });
    expect(s.board.resolves).toHaveLength(1);
    expect(s.said()).toEqual([]);
  });

  test("an answer left unfinished by a stopped run is given back at boot", async () => {
    const s = setup();
    s.posted();
    s.store.claimGateOutcome("gte_1");
    s.chat.resume();
    await s.chat.idle();
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(1);
    expect(s.replies()).toEqual(["Approved by Ana — the board has it."]);
  });
});

describe("who may answer", () => {
  test("a linked agent is refused, and nothing is asked of the board or said", async () => {
    const s = setup();
    s.posted();
    await s.deliver(answer({ sender: AGENT }));
    expect(s.plane.assertions()).toEqual([]);
    expect(s.board.resolves).toEqual([]);
    expect(s.said()).toEqual([]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
    expect(s.lines).toContain(
      'board-chat: a "agent" principal tried to answer gate "gte_1"; refused',
    );
  });

  test("a sender linked to nobody is refused and told once how to link", async () => {
    const s = setup();
    s.posted();
    expect(await s.chat.answer(answer({ sender: STRANGER }))).toEqual({
      status: "refused",
      reason: "unlinked-sender",
    });
    expect(s.plane.assertions()).toEqual([]);
    expect(s.board.resolves).toEqual([]);
    expect(s.replies()).toEqual([LINK_HINT_TEXT]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
  });

  test("the how-to-link reply goes at most once per person per room per day", async () => {
    let at = new Date("2026-11-12T08:00:00.000Z");
    const s = setup({ now: () => at });
    s.posted();
    await s.chat.answer(answer({ sender: STRANGER }));
    await s.chat.answer(answer({ sender: STRANGER }));
    at = new Date("2026-11-12T23:59:00.000Z");
    await s.chat.answer(answer({ sender: STRANGER }));
    expect(s.replies()).toEqual([LINK_HINT_TEXT]);
    // Somebody else unlinked in the same room is told too.
    await s.chat.answer(answer({ sender: `@other:${SERVER}` }));
    expect(s.replies()).toEqual([LINK_HINT_TEXT, LINK_HINT_TEXT]);
    // The next UTC day, once more.
    at = new Date("2026-11-13T00:01:00.000Z");
    await s.chat.answer(answer({ sender: STRANGER }));
    expect(s.replies()).toEqual([
      LINK_HINT_TEXT,
      LINK_HINT_TEXT,
      LINK_HINT_TEXT,
    ]);
    expect(s.board.resolves).toEqual([]);
  });

  test("an identity whose principal the plane no longer knows is linked to nobody", async () => {
    const s = setup();
    s.posted();
    delete s.plane.principals[ANA_PRN];
    await s.deliver(answer());
    expect(s.board.resolves).toEqual([]);
    expect(s.replies()).toEqual([LINK_HINT_TEXT]);
  });

  test("a plane that cannot be reached is said in the room, not read as unlinked", async () => {
    const s = setup();
    s.posted();
    s.plane.state.down = true;
    await s.deliver(answer());
    expect(s.board.resolves).toEqual([]);
    expect(s.replies()).toEqual([IDENTITY_UNAVAILABLE_TEXT]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
  });

  test("an assertion for somebody else is refused, and the gate stays answerable", async () => {
    const s = setup();
    s.posted();
    s.plane.state.asserts = "prn_somebody_else";
    await s.deliver(answer());
    expect(s.board.resolves).toEqual([]);
    expect(s.replies()).toEqual([
      "That did not go through (ASSERTION_MISMATCH): the account service would not vouch for you. Nothing has changed.",
    ]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();

    s.plane.state.asserts = ANA_PRN;
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(1);
  });

  test("an assertion the plane refuses is said, and one it cannot give is unavailable", async () => {
    const s = setup();
    s.posted();
    s.plane.state.assertionStatus = 423;
    await s.deliver(answer());
    s.plane.state.assertionStatus = 503;
    await s.deliver(answer());
    expect(s.board.resolves).toEqual([]);
    expect(s.replies()).toEqual([
      "That did not go through (ASSERTION_REFUSED): the account service would not vouch for you. Nothing has changed.",
      IDENTITY_UNAVAILABLE_TEXT,
    ]);
  });
});

describe("the board's refusal", () => {
  test("GATE_NOT_PENDING is said, and closes the gate to later answers", async () => {
    const s = setup();
    s.posted();
    s.board.state.next = { status: 409, code: "GATE_NOT_PENDING" };
    await s.deliver(answer());
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(1);
    expect(s.replies()).toEqual([ALREADY_DECIDED_TEXT, ALREADY_DECIDED_TEXT]);
    expect(s.said().filter((e) => e.type === GATE_OUTCOME_TYPE)).toEqual([]);
  });

  test("a refusal the hub names is said in its words, and the gate stays answerable", async () => {
    const s = setup();
    s.posted();
    s.board.state.next = { status: 409, code: "DECISION_EXPIRED" };
    await s.deliver(answer());
    expect(s.replies()).toEqual([
      "That has expired, so it can no longer be approved. Nothing has changed.",
    ]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
    s.board.state.next = { status: 200 };
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(2);
    expect(s.replies().at(-1)).toBe("Approved by Ana — the board has it.");
  });

  test("any other refusal, or a board out of reach, is logged and not said, and the gate stays answerable", async () => {
    const s = setup();
    s.posted();
    s.board.state.next = { status: 403, code: "SEPARATION_OF_DUTIES" };
    await s.deliver(answer());
    s.board.state.next = "unreachable";
    await s.deliver(answer());
    s.board.state.next = { status: 500 };
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(3);
    expect(s.said()).toEqual([]);
    expect(s.lines.filter((l) => l.includes("did not take"))).toEqual([
      'board-chat: the board did not take an answer to gate "gte_1" (SEPARATION_OF_DUTIES)',
      'board-chat: the board did not take an answer to gate "gte_1" (UNREACHABLE)',
      'board-chat: the board did not take an answer to gate "gte_1" (HTTP_500)',
    ]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
  });
});

describe("what is not an answer to a gate posted here", () => {
  test("each is ignored without asking anybody or saying anything", async () => {
    const s = setup();
    s.posted();
    s.posted("gte_other", gateOffer(GATE), {
      boardId: "brd_other",
      roomId: OTHER_ROOM,
      card: "$other-card",
      prose: "$other-prose",
    });
    await s.deliver(
      // A gate never posted.
      answer({ gateId: "gte_never" }),
      // Another board's gate, answered here, even when it references that gate's own card.
      answer({ gateId: "gte_other", ref: "$other-card" }),
      // A reference to some other event, or to another gate's card.
      answer({ ref: "$something-else" }),
      answer({ ref: "$other-card" }),
      // A quoted reply is not a reference, and no relation binds to nothing.
      answer({ relation: { "m.in_reply_to": { event_id: CARD } } }),
      answer({ ref: null }),
      // A room that is not a board room.
      answer({ room: `!elsewhere:${SERVER}` }),
      // This service's own namespace.
      answer({ sender: `@superexchange_board:${SERVER}` }),
      answer({ sender: `@superexchange_anything:${SERVER}` }),
      // Not a decision at all.
      {
        type: "m.room.message",
        room_id: ROOM,
        sender: ANA,
        content: { msgtype: "m.text", body: "approve" },
      },
    );
    expect(s.plane.calls).toEqual([]);
    expect(s.board.resolves).toEqual([]);
    expect(s.said()).toEqual([]);
  });

  test("an answer in a room that is not a board room is ignored, even for a gate recorded there", async () => {
    const s = setup();
    const room = `!not-a-board-room:${SERVER}`;
    s.posted("gte_1", gateOffer(GATE), { roomId: room });
    expect(await s.chat.answer(answer({ room }))).toEqual({
      status: "ignored",
      reason: "not-a-board-room",
    });
    expect(s.plane.calls).toEqual([]);
    expect(s.board.resolves).toEqual([]);
  });

  test("an answer on a board no longer opted in is ignored", async () => {
    const s = setup();
    s.posted();
    s.store.disableBoard("brd_7c1f");
    await s.deliver(answer());
    expect(s.plane.calls).toEqual([]);
    expect(s.board.resolves).toEqual([]);
  });

  test("a typed word is not an answer: the hub reads gate answers only as decisions", async () => {
    const s = setup();
    s.posted();
    await s.deliver({
      type: "m.room.message",
      room_id: ROOM,
      sender: ANA,
      event_id: "$typed",
      content: { msgtype: "m.text", body: "Approve" },
    });
    expect(s.board.resolves).toEqual([]);
  });
});

describe("a gate.v2 answer is checked against what the gate offered", () => {
  const SUBJECT_OFFER: GateOffer = {
    options: [
      {
        id: "approve_automatic",
        label: "Post automatically",
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
    subjectId: "aps_1",
    subjectDigest: "sha256:1",
    subjectPreviewComplete: true,
    variants: null,
    quorum: null,
  };
  const BINDING = { id: "aps_1", digest: "sha256:1" };

  test("an offered option, bound to the subject, is carried with its binding", async () => {
    const s = setup();
    s.posted("gte_1", SUBJECT_OFFER);
    await s.deliver(
      answer({ version: 2, option: "approve_automatic", subject: BINDING }),
    );
    expect(s.board.resolves.map((r) => r.body)).toEqual([
      {
        decision: "approve_automatic",
        approvalSubjectId: "aps_1",
        approvalSubjectDigest: "sha256:1",
      },
    ]);
    expect(s.replies()).toEqual([
      "Approved for automatic delivery by Ana — the board has it.",
    ]);
  });

  const refusals: Array<
    [string, GateOffer | null, Parameters<typeof answer>[0], string]
  > = [
    [
      "an option the gate did not offer",
      SUBJECT_OFFER,
      { version: 2, option: "ship_it", subject: BINDING },
      "That is not one of this gate's options. Nothing has changed.",
    ],
    [
      "an option that needs a comment, without one",
      SUBJECT_OFFER,
      { version: 2, option: "request_changes", comment: " ", subject: BINDING },
      "That answer needs a comment. Nothing has changed.",
    ],
    [
      "an answer to a subject-bound gate that names no subject",
      SUBJECT_OFFER,
      { version: 2, option: "approve_automatic" },
      "That answer did not say which version it approves. Nothing has changed.",
    ],
    [
      "an approval of a subject whose preview was not shown in full",
      { ...SUBJECT_OFFER, subjectPreviewComplete: false },
      { version: 2, option: "approve_automatic", subject: BINDING },
      "The card could not show everything being approved, so it cannot be approved from here. Open the card on the board. Nothing has changed.",
    ],
    [
      "any v2 answer to a gate posted before offers were recorded",
      null,
      { version: 2, option: "approve" },
      "That is not one of this gate's options. Nothing has changed.",
    ],
  ];
  for (const [label, offer, a, text] of refusals) {
    test(`refused before the board: ${label}`, async () => {
      const s = setup();
      s.posted("gte_1", offer);
      await s.deliver(answer(a));
      expect(s.board.resolves).toEqual([]);
      expect(s.plane.assertions()).toEqual([]);
      expect(s.replies()).toEqual([text]);
      expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
    });
  }

  test("refusals are said only to a person: an agent's bad answer is refused silently", async () => {
    const s = setup();
    s.posted("gte_1", SUBJECT_OFFER);
    await s.deliver(answer({ version: 2, option: "ship_it", sender: AGENT }));
    expect(s.said()).toEqual([]);
  });

  const CHOICE: GateOffer = {
    options: [
      {
        id: "approve",
        label: "Approve",
        meaning: "approve",
        needs_comment: false,
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
    variants: [
      {
        id: "short",
        label: "Short version",
        subject_id: "aps_s",
        digest: "sha256:s",
        preview_complete: true,
        expires_at: null,
      },
      {
        id: "long",
        label: "Long version",
        subject_id: "aps_l",
        digest: "sha256:l",
        preview_complete: false,
        expires_at: null,
      },
      {
        id: "old",
        label: "Old version",
        subject_id: "aps_o",
        digest: "sha256:o",
        preview_complete: true,
        expires_at: "2026-11-01T00:00:00.000Z",
      },
    ],
    quorum: null,
  };

  test("a choice: the approval names its variant, which the receipt names; a rejection carries no binding", async () => {
    const s = setup();
    s.posted("gte_1", CHOICE);
    s.posted("gte_2", CHOICE, { card: "$card2", prose: "$prose2" });
    await s.deliver(
      answer({ version: 2, subject: { id: "aps_s", digest: "sha256:s" } }),
      answer({
        version: 2,
        gateId: "gte_2",
        ref: "$card2",
        option: "reject",
        subject: { id: "aps_s", digest: "sha256:s" },
      }),
    );
    expect(s.board.resolves.map((r) => r.body)).toEqual([
      {
        decision: "approve",
        approvalSubjectId: "aps_s",
        approvalSubjectDigest: "sha256:s",
      },
      { decision: "reject" },
    ]);
    expect(s.replies()).toEqual([
      'Approved "Short version" by Ana — the board has it.',
      "Rejected by Ana — the board has it.",
    ]);
    expect(
      s.said().find((e) => e.type === GATE_OUTCOME_TYPE)?.content
        .chosen_variant,
    ).toEqual({ id: "short", label: "Short version" });
  });

  const choiceRefusals: Array<[string, Parameters<typeof answer>[0], string]> =
    [
      [
        "an approval naming no variant",
        { version: 2 },
        "That answer did not say which version it chooses. Nothing has changed.",
      ],
      [
        "an approval naming a variant not offered",
        { version: 2, subject: { id: "aps_x", digest: "sha256:x" } },
        "That is not one of the versions this gate offers. Nothing has changed.",
      ],
      [
        "a variant not shown in full",
        { version: 2, subject: { id: "aps_l", digest: "sha256:l" } },
        "That version couldn't be shown in full here — choose it on the board. Nothing has changed.",
      ],
      [
        "an expired variant",
        { version: 2, subject: { id: "aps_o", digest: "sha256:o" } },
        "That version has expired, so it can no longer be chosen. Nothing has changed.",
      ],
      [
        "a v1 approval, which can name no variant",
        { version: 1 },
        "Choose a version in an updated app or on the board. Nothing has changed.",
      ],
    ];
  for (const [label, a, text] of choiceRefusals) {
    test(`a choice, refused before the board: ${label}`, async () => {
      const s = setup();
      s.posted("gte_1", CHOICE);
      await s.deliver(answer(a));
      expect(s.board.resolves).toEqual([]);
      expect(s.replies()).toEqual([text]);
    });
  }

  test("a quorum gate: an accepted approval is recorded, not passed; the next approver may act", async () => {
    const s = setup();
    s.posted("gte_1", {
      ...gateOffer(GATE),
      quorum: { required: 2, from: "admins", approvals: [] },
    });
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(1);
    expect(s.said()).toEqual([]);
    expect(s.store.gateEvent("gte_1")?.outcomeClaimedAt).toBeNull();
    s.board.state.next = { status: 403, code: "APPROVAL_DECIDER_NOT_ALLOWED" };
    await s.deliver(answer());
    expect(s.board.resolves).toHaveLength(2);
    expect(s.replies()).toEqual([
      "This gate needs approvals from the workspace's owners and admins, so your approval does not count here. Nothing has changed.",
    ]);
  });
});

describe("no secret reaches a log or the room", () => {
  test("the credential, the assertion and the URLs appear in no log line or message", async () => {
    const s = setup();
    s.posted();
    s.plane.state.down = true;
    await s.deliver(answer());
    s.plane.state.down = false;
    s.plane.state.asserts = "prn_x";
    await s.deliver(answer());
    s.plane.state.asserts = ANA_PRN;
    s.board.state.next = "unreachable";
    await s.deliver(answer());
    s.board.state.next = { status: 200 };
    await s.deliver(answer());
    const everything = [
      ...s.lines,
      ...s.said().map((e) => JSON.stringify(e.content)),
    ].join("\n");
    for (const secret of [
      CREDENTIAL.secret,
      CREDENTIAL.id,
      token(ANA_PRN),
      token("prn_x"),
      PLANE_URL,
      SP_URL,
      AS_TOKEN,
      "ECONNREFUSED",
    ])
      expect(everything).not.toContain(secret);
  });
});

// ── treaty's corpus ─────────────────────────────────────────────────────────

type Case = {
  why: string;
  refusedBy: "schema" | "unique" | "recorded";
  body: Record<string, unknown>;
};
type Corpus = {
  schemas: Record<
    string,
    { valid: Record<string, Record<string, unknown>>; invalid: Case[] }
  >;
};
// Read, not imported: a typed import of the whole corpus is a literal type the compiler chokes on.
const corpus: Corpus = JSON.parse(
  readFileSync(
    Bun.resolveSync(
      "@superjackfruitlabs/treaty-matrix-events/examples.json",
      import.meta.dir,
    ),
    "utf8",
  ),
);

/**
 * What this service would have recorded when it posted the gate an answer names: the same gate
 * id, in this room, under the event the corpus answers (`$gateEventId`), offering the option
 * answered and bound to the subject the answer names. Built from the answer, so a refusal can only
 * be the answer's own fault; the `recorded` cases need a particular record and are judged above.
 */
function recordFor(content: Record<string, unknown>): {
  gateId: string;
  offer: GateOffer;
} {
  const option =
    typeof content.option_id === "string" ? content.option_id : null;
  const bound =
    typeof content.subject === "object" && content.subject !== null
      ? (content.subject as Record<string, unknown>)
      : {};
  const meaning = option?.startsWith("approve")
    ? "approve"
    : option === "request_changes"
      ? "revise"
      : "reject";
  const v2 = content.suite_event_type === "dev.superpipeline.gate.decision.v2";
  return {
    gateId:
      typeof content.gate_id === "string" ? content.gate_id : "gte_corpus",
    // A gate.v1 recorded the v1 options; a gate.v2 offered the one answered.
    offer:
      v2 && option
        ? {
            options: [
              {
                id: option,
                label: option,
                meaning,
                needs_comment: option === "request_changes",
              },
            ],
            subjectId: typeof bound.id === "string" ? bound.id : null,
            subjectDigest:
              typeof bound.digest === "string" ? bound.digest : null,
            subjectPreviewComplete: true,
            variants: null,
            quorum: null,
          }
        : gateOffer(GATE),
  };
}

/** Run one corpus answer through the homeserver's path; how many times did it reach the board? */
async function acts(content: Record<string, unknown>): Promise<number> {
  const s = setup();
  const { gateId, offer } = recordFor(content);
  s.posted(gateId, offer, { card: "$gateEventId" });
  await s.deliver({
    type: "m.room.message",
    room_id: ROOM,
    sender: ANA,
    event_id: "$corpus",
    content,
  });
  return s.board.resolves.length;
}

for (const type of [
  "dev.superpipeline.gate.decision.v1",
  "dev.superpipeline.gate.decision.v2",
]) {
  const cases = corpus.schemas[type] ?? { valid: {}, invalid: [] };
  describe(`treaty's corpus: ${type}`, () => {
    test("has valid and invalid cases", () => {
      expect(Object.keys(cases.valid).length).toBeGreaterThan(0);
      expect(cases.invalid.length).toBeGreaterThan(0);
    });
    for (const [label, content] of Object.entries(cases.valid)) {
      test(`reaches the board once: ${label}`, async () => {
        expect(await acts(content)).toBe(1);
      });
    }
    for (const c of cases.invalid.filter((k) => k.refusedBy !== "recorded")) {
      test(`never reaches the board (${c.refusedBy}): ${c.why}`, async () => {
        expect(await acts(c.body)).toBe(0);
      });
    }
  });
}
