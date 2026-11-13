/**
 * Posting a delivered gate into its board's room, exactly once.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-projection.ts`. A gate is two events,
 * built only by treaty:
 *
 * - the prose message (`m.room.message`): `gateV2Content`, the gate.v2 a person reads and a v2
 *   client answers, carrying the v1 card (`gateRequestCard`) under `GATE_REQUEST_CONTENT_KEY`;
 * - the custom card event (`GATE_EVENT_TYPE`, `gateEventContent`) that clients in the field still
 *   draw buttons from.
 *
 * Prose first, as the hub does: if only one lands, the room has a readable question rather than
 * buttons without context.
 *
 * The order of a post:
 *
 * 1. The board's room, made once (`rooms.ts`): encrypted, unless `SUPEREXCHANGE_PLAINTEXT_ROOMS`
 *    is on (staging only).
 * 2. Fail closed on encryption (`room-sender.ts`): a room made in plaintext is not posted into
 *    while plaintext rooms are off, and an encrypted room is not posted into without the
 *    speaker's keys. The gate stays recorded and unposted; the refusal is logged once per board.
 * 3. Held until a person has joined: no claim is taken, so the next join or boot posts it.
 * 4. The claim: a `gate_events` row inserted or ignored, before anything is sent. A gate that is
 *    already posted is never sent again.
 * 5. The sends, each under a transaction id derived from the gate, so a retry of a claimed,
 *    unfinished gate is answered by the homeserver with the first send's event rather than a
 *    second message. The prose's id is kept as soon as it lands, so a retry after the card failed
 *    sends only the card.
 *
 * Posts run one at a time, in arrival order, off the request that caused them: neither the relay
 * nor the homeserver's transaction waits on a post. A gate the board says was decided elsewhere
 * is settled in the same queue (`gate-receipt.ts`), so settling never runs beside an answer to
 * the same gate; a settled gate is never posted. A gate held for a join is logged once.
 *
 * The way in: an encrypted event in a board room, from a person, is decrypted before anything
 * reads it (the hub's `asPlaintext`), then read like any other: a gate answer, a question answer,
 * a follow-up's or a waiting card's answer, or a typed reply to a question is carried
 * (questions: `question-card.ts`, `question-answer.ts`; follow-ups: `followup-card.ts`,
 * `followup-answer.ts`; waiting cards: `attention-card.ts`, `attention-answer.ts`; all sharing
 * this queue). One whose key has not arrived yet waits, still encrypted, in the store (`pending_decrypts`; the
 * hub's `pending-decrypts.ts`): the homeserver has been told the transaction was applied and
 * never sends it again, so an event held in memory would be lost by any restart. It is tried
 * again after every transaction that brought keys and at boot, given up after
 * `PENDING_TTL_MS`, and at most `PENDING_MAX` wait. Parking is logged once per event, without
 * its content.
 */
import {
  GATE_EVENT_TYPE,
  GATE_REQUEST_CONTENT_KEY,
  gateEventContent,
  gateRequestCard,
  gateV2Content,
  isGatePending,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  ENCRYPTED_EVENT_TYPE,
  type EventsHandler,
  type MatrixEvent,
  type RoomCrypto,
} from "../appservice/index.ts";
import type {
  BoardRoom,
  EscalationInvite,
  Store,
  WaitKey,
} from "../store/index.ts";
import type {
  AttentionAnswerOutcome,
  AttentionAnswers,
} from "./attention-answer.ts";
import {
  postAttention,
  settleAttention,
  type AttentionPostOutcome,
  type AttentionSettleOutcome,
} from "./attention-card.ts";
import type {
  FollowupAnswerOutcome,
  FollowupAnswers,
} from "./followup-answer.ts";
import {
  postFollowup,
  settleFollowup,
  type FollowupPostOutcome,
  type FollowupSettleOutcome,
} from "./followup-card.ts";
import type { AnswerOutcome, GateAnswers } from "./gate-answer.ts";
import {
  MAX_REPOST_ATTEMPTS,
  repostForInvite,
  type RepostDeps,
  type RepostReads,
} from "./escalation-repost.ts";
import {
  postNotice,
  type NoticePostDeps,
  type NoticePostOutcome,
} from "./notice-post.ts";
import type { MarkedAnswers, PersonCallOutcome } from "./pull-back.ts";
import type {
  QuestionAnswerOutcome,
  QuestionAnswers,
} from "./question-answer.ts";
import {
  postQuestion,
  settleQuestion,
  type QuestionPostOutcome,
  type QuestionSettleOutcome,
} from "./question-card.ts";
import {
  settleGate,
  type GateDecided,
  type SettleOutcome,
} from "./gate-receipt.ts";
import type { RoomRefusal, RoomSender } from "./room-sender.ts";
import { gateOffer, gateTxnId } from "./gate-offer.ts";
import { describe, type BoardRooms } from "./rooms.ts";

export { gateOffer, gateTxnId } from "./gate-offer.ts";

/** How long an encrypted event may wait for its key before it is given up on. */
export const PENDING_TTL_MS = 60 * 60_000;
/** At most this many wait: a room whose keys never come must not grow the table without end. */
export const PENDING_MAX = 200;

/** The event type of the prose message. */
const MESSAGE = "m.room.message";

export type PostOutcome =
  | {
      status: "posted";
      roomId: string;
      proseEventId: string;
      cardEventId: string;
    }
  | { status: "already" }
  | { status: "held"; roomId: string }
  | { status: "refused"; reason: RoomRefusal }
  | {
      status: "skipped";
      reason:
        | "not delivered"
        | "settled"
        | "not a gate"
        | "board not opted in"
        | "board disabled";
    }
  | { status: "failed"; step: "room" | "membership" | "send" };

/** What the notices need beyond the room: whom to invite, and what to read. */
export interface NoticeChatDeps {
  invite?: NoticePostDeps["invite"];
  recipients?: NoticePostDeps["recipients"];
  labelFor?: NoticePostDeps["labelFor"];
  /** The board's reads: a card's checks, and what it waits on for a re-post. */
  reads?: Partial<RepostReads>;
}

export interface BoardChatDeps {
  store: NoticePostDeps["store"] &
    RepostDeps["store"] &
    Pick<
      Store,
      "unpostedNotices" | "recordInviteJoined" | "invitesOwingReposts"
    > &
    Pick<
      Store,
      | "getBoard"
      | "gateDelivery"
      | "unpostedGates"
      | "boardRoomByRoomId"
      | "recordMembership"
      | "claimGateEvent"
      | "gateEvent"
      | "recordGateProse"
      | "recordGatePosted"
      | "boardRoom"
      | "parkPendingDecrypt"
      | "pendingDecrypts"
      | "claimPendingDecrypt"
      | "settleGateEvent"
      | "settleGateDelivery"
      | "questionDelivery"
      | "questionEvent"
      | "claimQuestionEvent"
      | "recordQuestionPosted"
      | "unpostedQuestions"
      | "settleQuestionDelivery"
      | "settleQuestionEvent"
      | "followupDelivery"
      | "followupEvent"
      | "claimFollowupEvent"
      | "recordFollowupPosted"
      | "unpostedFollowups"
      | "settleFollowupDelivery"
      | "settleFollowupEvent"
      | "attentionDelivery"
      | "attentionEvent"
      | "claimAttentionEvent"
      | "recordAttentionPosted"
      | "unpostedAttention"
      | "settleAttentionDelivery"
      | "settleAttentionEvent"
    >;
  /** Speaks in board rooms, encrypted where the room is (`room-sender.ts`). */
  sender: RoomSender;
  rooms: BoardRooms;
  /** The speaker's encryption, for events coming in; null, an encrypted event is not read. */
  crypto: RoomCrypto | null;
  /** People's answers to the gates posted here (`gate-answer.ts`); absent, none is read. */
  answers?: GateAnswers;
  /** People's answers to the questions posted here (`question-answer.ts`); absent, none is read. */
  questions?: QuestionAnswers;
  /** People's answers to the follow-ups posted here (`followup-answer.ts`); absent, none is read. */
  followups?: FollowupAnswers;
  /** People's answers to the waiting cards posted here (`attention-answer.ts`); absent, none is read. */
  attention?: AttentionAnswers;
  /** Pull-backs of held approvals (`pull-back.ts`); absent, none is read. */
  pullBacks?: MarkedAnswers;
  /** Overrides of checks (`pull-back.ts`); absent, none is read. */
  overrides?: MarkedAnswers;
  /** The board-room notices' neighbours; absent, escalations invite nobody and read nothing. */
  notices?: NoticeChatDeps;
  log: (line: string) => void;
  now?: () => Date;
}

export interface BoardChat {
  /** Post one gate, queued behind every post before it. */
  post(gateId: string): Promise<PostOutcome>;
  /** A gate the relay accepted: queue its post and return at once. */
  gateAccepted(gateId: string): void;
  /** Every delivered gate not yet posted: queued at boot. */
  resume(): void;
  /**
   * The homeserver's events: a gate answer is queued to be carried to the board, before anything
   * else reads the event; memberships of board rooms are kept, and a person's join posts the held
   * gates.
   */
  onEvents: EventsHandler;
  /**
   * Settle a gate the board says was decided elsewhere, queued behind every post and answer
   * before it: its receipt once if it is in a room, and never posted if it is not.
   */
  settle(gateId: string, decided: GateDecided): Promise<SettleOutcome>;
  /** Carry one answer, queued behind every post and answer before it. */
  answer(event: MatrixEvent): Promise<AnswerOutcome | null>;
  /**
   * Try every encrypted event waiting for its key again: after a transaction brought keys, and
   * at boot. Settles when the try is done (answers it found are queued, not awaited).
   */
  retryPending(): Promise<void>;
  /** Post one question, queued behind every post and answer before it. */
  postQuestion(elicitationId: string): Promise<QuestionPostOutcome>;
  /** A question the relay accepted: queue its post and return at once. */
  questionAccepted(elicitationId: string): void;
  /** Close a question the board no longer waits on, queued like a settle. */
  settleQuestion(elicitationId: string): Promise<QuestionSettleOutcome>;
  /** Carry one question answer (question.answer.v2 or a typed reply), queued. */
  answerQuestion(event: MatrixEvent): Promise<QuestionAnswerOutcome | null>;
  /** Post one follow-up, queued behind every post and answer before it. */
  postFollowup(gateId: string): Promise<FollowupPostOutcome>;
  /** A follow-up the relay accepted: queue its post and return at once. */
  followupAccepted(gateId: string): void;
  /** Settle a follow-up the board no longer owes, queued like a gate's settle. */
  settleFollowup(gateId: string): Promise<FollowupSettleOutcome>;
  /** Carry one delivery.answer.v2, queued. */
  answerFollowup(event: MatrixEvent): Promise<FollowupAnswerOutcome | null>;
  /** Post one waiting card, queued behind every post and answer before it. */
  postAttention(key: WaitKey): Promise<AttentionPostOutcome>;
  /** A waiting card the relay accepted: queue its post and return at once. */
  attentionAccepted(key: WaitKey): void;
  /** Close a waiting card whose wait ended elsewhere, queued like a gate's settle. */
  settleAttention(key: WaitKey): Promise<AttentionSettleOutcome>;
  /** Carry one attention.answer.v2, queued. */
  answerAttention(event: MatrixEvent): Promise<AttentionAnswerOutcome | null>;
  /** Post one recorded notice, queued behind every post and answer before it. */
  postNotice(noticeId: string): Promise<NoticePostOutcome>;
  /** A notice the relay accepted: queue its post and return at once. */
  noticeAccepted(noticeId: string): void;
  /** Queue every notice not yet posted, and every join still owed its re-posts. */
  retryNotices(): void;
  /** Re-post a board's open escalations for an invitee who joined, queued. */
  repost(invite: EscalationInvite): Promise<number>;
  /** Carry one gate.pull_back.v2, queued. */
  answerPullBack(event: MatrixEvent): Promise<PersonCallOutcome | null>;
  /** Carry one check.override.v2, queued. */
  answerOverride(event: MatrixEvent): Promise<PersonCallOutcome | null>;
  /** Settles when every queued post has run. */
  idle(): Promise<void>;
}

export function createBoardChat(deps: BoardChatDeps): BoardChat {
  const { store, sender, rooms, log } = deps;
  const now = deps.now ?? (() => new Date());
  const refusedBoards = new Set<string>();
  /** Gates and questions whose hold has been logged: the sweeps offer them again every pass. */
  const heldLogged = new Set<string>();

  /** Why a board's room may not be spoken in, logged once per board and reason; null when it may. */
  function refusalFor(
    boardId: string,
    room: Pick<BoardRoom, "encrypted">,
  ): RoomRefusal | null {
    const reason = sender.refusal(room);
    if (reason === null) return null;
    const key = `${boardId}\u0000${reason}`;
    if (!refusedBoards.has(key)) {
      refusedBoards.add(key);
      log(
        reason === "plaintext room"
          ? `board-chat: ${boardId}'s room was made without encryption and is left as it is: nothing is posted into it while SUPEREXCHANGE_PLAINTEXT_ROOMS is off`
          : `board-chat: ${boardId}'s room is encrypted and the speaker has no keys (SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set): nothing is posted into it`,
      );
    }
    return reason;
  }
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work);
    // The chain never rejects: one failed post must not stop the ones queued behind it.
    queue = run.catch(() => undefined);
    return run;
  }

  async function postOnce(gateId: string): Promise<PostOutcome> {
    const delivery = store.gateDelivery(gateId);
    if (delivery === null)
      return { status: "skipped", reason: "not delivered" };
    // Decided on the board before it was posted: never posted after.
    if (delivery.settledAt !== null)
      return { status: "skipped", reason: "settled" };
    const gate = delivery.body;
    if (!isGatePending(gate))
      return { status: "skipped", reason: "not a gate" };
    const board = store.getBoard(gate.boardId);
    if (board === null)
      return { status: "skipped", reason: "board not opted in" };
    if (!board.enabled) return { status: "skipped", reason: "board disabled" };

    const claimed = store.gateEvent(gateId);
    if (claimed?.postedAt) return { status: "already" };

    /** Null when the room may be spoken in; else the refusal, logged once per board and reason. */
    const refuse = (room: Pick<BoardRoom, "encrypted">): PostOutcome | null => {
      const reason = refusalFor(board.boardId, room);
      return reason === null ? null : { status: "refused", reason };
    };

    const known = claimed
      ? store.boardRoomByRoomId(claimed.roomId)
      : store.boardRoom(board.boardId);
    if (known) {
      const refused = refuse(known);
      if (refused) return refused;
    }

    let roomId: string;
    if (claimed) {
      // Claimed by an earlier try that did not finish: it passed the hold then, and its room is
      // the one on the claim.
      roomId = claimed.roomId;
    } else {
      try {
        const room = await rooms.ensure(board, gate.boardName ?? undefined);
        const refused = refuse(room);
        if (refused) return refused;
        roomId = room.roomId;
      } catch (error) {
        log(
          `board-chat: gate ${JSON.stringify(gateId)} has no room on ${board.boardId} (${describe(error)})`,
        );
        return { status: "failed", step: "room" };
      }
      try {
        if (!(await rooms.personJoined(roomId))) {
          if (!heldLogged.has(gateId)) {
            heldLogged.add(gateId);
            log(
              `board-chat: gate ${JSON.stringify(gateId)} held until a person joins the room of ${board.boardId}`,
            );
          }
          return { status: "held", roomId };
        }
      } catch (error) {
        log(
          `board-chat: gate ${JSON.stringify(gateId)} held: the room's members could not be read (${describe(error)})`,
        );
        return { status: "failed", step: "membership" };
      }
      // The claim is the gate on the send, not a record of it: taken before anything is sent,
      // with what the gate offers, so an answer to it is checked against what was posted.
      store.claimGateEvent(gateId, board.boardId, roomId, gateOffer(gate));
    }

    const claim = store.gateEvent(gateId);
    if (claim === null) return { status: "failed", step: "send" };
    roomId = claim.roomId;

    try {
      let proseEventId = claim.proseEventId;
      if (proseEventId === null) {
        proseEventId = await sender.sendEvent(
          rooms.speaker,
          roomId,
          MESSAGE,
          gateTxnId(gateId, "prose"),
          {
            ...gateV2Content(gate),
            [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(gate),
          },
        );
        store.recordGateProse(gateId, proseEventId);
      }
      const cardEventId = await sender.sendEvent(
        rooms.speaker,
        roomId,
        GATE_EVENT_TYPE,
        gateTxnId(gateId, "card"),
        gateEventContent(gate),
      );
      store.recordGatePosted(gateId, cardEventId);
      log(
        `board-chat: gate ${JSON.stringify(gateId)} posted on ${board.boardId}`,
      );
      return { status: "posted", roomId, proseEventId, cardEventId };
    } catch (error) {
      // The claim stays: the next join or boot sends what is missing under the same ids.
      log(
        `board-chat: gate ${JSON.stringify(gateId)} not posted on ${board.boardId} (${describe(error)}); it is retried at the next join or boot`,
      );
      return { status: "failed", step: "send" };
    }
  }

  const post = (gateId: string) => enqueue(() => postOnce(gateId));
  const answers = deps.answers;
  // Answers share the posts' queue: an answer to a gate whose post is still running waits for it.
  const answer = (event: MatrixEvent) =>
    enqueue(async () => (answers ? answers.handle(event) : null)).catch(
      (error: unknown) => {
        log(
          `board-chat: a gate answer could not be carried (${describe(error)})`,
        );
        return null;
      },
    );
  const questions = deps.questions;
  const questionDeps = {
    store,
    sender,
    rooms,
    refuse: refusalFor,
    held(elicitationId: string, boardId: string) {
      const key = `question\u0000${elicitationId}`;
      if (heldLogged.has(key)) return;
      heldLogged.add(key);
      log(
        `board-chat: question ${JSON.stringify(elicitationId)} held until a person joins the room of ${boardId}`,
      );
    },
    log,
  };
  const postQ = (elicitationId: string) =>
    enqueue(() => postQuestion(questionDeps, elicitationId));
  /** A question answer, carried in the posts' queue; which way in is decided by the caller. */
  const answerQuestion = (event: MatrixEvent, typed = false) =>
    enqueue(async () =>
      questions
        ? typed
          ? questions.handleTyped(event)
          : questions.handle(event)
        : null,
    ).catch((error: unknown) => {
      log(
        `board-chat: a question answer could not be carried (${describe(error)})`,
      );
      return null;
    });

  /** A single-event card's post: logged once when held, like a question. */
  const cardDeps = {
    store,
    sender,
    rooms,
    refuse: refusalFor,
    held(key: string, at: string, boardId: string) {
      if (heldLogged.has(key)) return;
      heldLogged.add(key);
      log(`board-chat: ${at} held until a person joins the room of ${boardId}`);
    },
    log,
    now,
  };
  const postF = (gateId: string) =>
    enqueue(() => postFollowup(cardDeps, gateId));
  const postA = (key: WaitKey) => enqueue(() => postAttention(cardDeps, key));
  const settleDeps = { store, sender, speaker: rooms.speaker, log };
  /** An answer to a single-event card, carried in the posts' queue. */
  function carry<T>(
    what: string,
    handler: { handle(event: MatrixEvent): Promise<T> } | undefined,
    event: MatrixEvent,
  ): Promise<T | null> {
    return enqueue(async () => (handler ? handler.handle(event) : null)).catch(
      (error: unknown) => {
        log(
          `board-chat: ${what} answer could not be carried (${describe(error)})`,
        );
        return null;
      },
    );
  }
  const followups = deps.followups;
  const attention = deps.attention;
  const answerF = (event: MatrixEvent) =>
    carry("a follow-up's", followups, event);
  const answerA = (event: MatrixEvent) =>
    carry("a waiting card's", attention, event);

  const pullBacks = deps.pullBacks;
  const overrides = deps.overrides;
  const answerP = (event: MatrixEvent) =>
    carry("a pull-back's", pullBacks, event);
  const answerO = (event: MatrixEvent) =>
    carry("a check override's", overrides, event);

  const n = deps.notices ?? {};
  const noticeDeps: NoticePostDeps = {
    store,
    sender,
    speaker: rooms.speaker,
    refuse: refusalFor,
    ...(n.invite ? { invite: n.invite } : {}),
    ...(n.recipients ? { recipients: n.recipients } : {}),
    ...(n.labelFor ? { labelFor: n.labelFor } : {}),
    ...(n.reads?.cardChecks
      ? {
          checks: {
            cardChecks: (b: string, c: string) =>
              (n.reads as RepostReads).cardChecks(b, c),
          },
        }
      : {}),
    log,
  };
  const repostDeps: RepostDeps = {
    store,
    sender,
    speaker: rooms.speaker,
    ...(n.reads ? { reads: n.reads } : {}),
    log,
    now,
  };
  const postN = (noticeId: string) =>
    enqueue(() => postNotice(noticeDeps, noticeId));
  const repost = (invite: EscalationInvite) =>
    enqueue(() => repostForInvite(repostDeps, invite)).catch(
      (error: unknown) => {
        log(
          `board-chat: escalations could not be posted again (${describe(error)})`,
        );
        return 0;
      },
    );
  const retryNotices = () => {
    for (const notice of store.unpostedNotices()) void postN(notice.noticeId);
    for (const invite of store.invitesOwingReposts(MAX_REPOST_ATTEMPTS))
      void repost(invite);
  };

  const postAll = (boardId?: string) => {
    for (const gate of store.unpostedGates(boardId)) void post(gate.gateId);
    for (const q of store.unpostedQuestions(boardId))
      void postQ(q.elicitationId);
    for (const f of store.unpostedFollowups(boardId)) void postF(f.gateId);
    for (const a of store.unpostedAttention(boardId))
      void postA({ boardId: a.boardId, cardId: a.cardId, waitId: a.waitId });
    for (const notice of store.unpostedNotices(boardId))
      void postN(notice.noticeId);
  };

  /**
   * What a person's message is read as, before anything else reads it: a gate answer, a
   * question.answer.v2, a delivery.answer.v2, an attention.answer.v2, or a typed reply to the
   * question open in its room. True when it was one. The envelope's answers come before a typed
   * reply: one is never read as a number for the question open in the room.
   */
  function routeAnswer(event: MatrixEvent): boolean {
    if (answers?.isAnswer(event)) {
      void answer(event);
      return true;
    }
    if (questions?.isAnswer(event)) {
      void answerQuestion(event);
      return true;
    }
    if (followups?.isAnswer(event)) {
      void answerF(event);
      return true;
    }
    if (attention?.isAnswer(event)) {
      void answerA(event);
      return true;
    }
    // Matched by marker alone, before a typed reply: a malformed pull-back or override is refused
    // there, never read as a number for the question open in the room.
    if (pullBacks?.isAnswer(event)) {
      void answerP(event);
      return true;
    }
    if (overrides?.isAnswer(event)) {
      void answerO(event);
      return true;
    }
    if (questions?.isTypedReply(event)) {
      void answerQuestion(event, true);
      return true;
    }
    return false;
  }

  /** What a decrypted event is read as: an answer is carried; nothing else is read yet. */
  function read(event: MatrixEvent): void {
    routeAnswer(event);
  }

  /**
   * The board room an encrypted event is in, when it is one this service may read: a person's,
   * in a room it owns. Its own events and anybody else's rooms are not its to decrypt.
   */
  function encryptedInBoardRoom(event: MatrixEvent): BoardRoom | null {
    const { room_id: roomId, sender: from } = event;
    if (typeof roomId !== "string" || typeof from !== "string") return null;
    if (!rooms.isPerson(from)) return null;
    return store.boardRoomByRoomId(roomId);
  }

  /** The event's own parts over its envelope, or null when its key is not here. */
  async function decrypted(event: MatrixEvent): Promise<MatrixEvent | null> {
    if (deps.crypto === null) return null;
    let plain;
    try {
      plain = await deps.crypto.decrypt(event);
    } catch (error) {
      log(
        `board-chat: an encrypted event could not be decrypted (${describe(error)})`,
      );
      return null;
    }
    return plain === null
      ? null
      : { ...event, type: plain.type, content: plain.content };
  }

  async function inbound(event: MatrixEvent, room: BoardRoom): Promise<void> {
    const plain = await decrypted(event);
    if (plain !== null) return read(plain);
    const eventId = event.event_id;
    if (typeof eventId !== "string" || typeof event.room_id !== "string")
      return;
    if (
      store.parkPendingDecrypt(
        eventId,
        event.room_id,
        { ...event },
        PENDING_MAX,
      )
    ) {
      log(
        `board-chat: an encrypted event in the room of ${room.boardId} cannot be decrypted yet; it waits for its key`,
      );
    }
  }

  // Incoming encrypted events and retries share one chain, in arrival order: a retry after keys
  // arrived runs after every event that came before it has been parked.
  let incoming: Promise<unknown> = Promise.resolve();
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const run = incoming.then(work);
    incoming = run.catch(() => undefined);
    return run;
  }

  function retryPending(): Promise<void> {
    return inOrder(async () => {
      for (const row of store.pendingDecrypts()) {
        const waited = now().getTime() - Date.parse(row.firstSeenAt);
        if (!(waited <= PENDING_TTL_MS)) {
          if (store.claimPendingDecrypt(row.eventId)) {
            const room = store.boardRoomByRoomId(row.roomId);
            log(
              `board-chat: an encrypted event in the room of ${room?.boardId ?? "a board no longer here"} never got its key; given up`,
            );
          }
          continue;
        }
        const plain = await decrypted(row.event as MatrixEvent);
        if (plain === null) continue;
        // Taken off the list before it is read, so two retries never act on it twice.
        if (!store.claimPendingDecrypt(row.eventId)) continue;
        read(plain);
      }
    });
  }

  const settle = (gateId: string, decided: GateDecided) =>
    enqueue(() =>
      settleGate(
        { store, sender, speaker: rooms.speaker, log, describe },
        gateId,
        decided,
      ),
    );

  return {
    post,
    settle,
    gateAccepted: (gateId) => void post(gateId),
    answer,
    postQuestion: postQ,
    questionAccepted: (elicitationId) => void postQ(elicitationId),
    settleQuestion: (elicitationId) =>
      enqueue(() =>
        settleQuestion(
          { store, sender, speaker: rooms.speaker, log },
          elicitationId,
        ),
      ),
    answerQuestion: (event) => answerQuestion(event),
    postFollowup: postF,
    followupAccepted: (gateId) => void postF(gateId),
    settleFollowup: (gateId) =>
      enqueue(() => settleFollowup(settleDeps, gateId)),
    answerFollowup: answerF,
    postAttention: postA,
    attentionAccepted: (key) => void postA(key),
    settleAttention: (key) => enqueue(() => settleAttention(settleDeps, key)),
    answerAttention: answerA,
    postNotice: postN,
    noticeAccepted: (noticeId) => void postN(noticeId),
    retryNotices,
    repost,
    answerPullBack: answerP,
    answerOverride: answerO,
    retryPending,
    resume: () => {
      answers?.resume();
      postAll();
      retryNotices();
      void retryPending().catch((error: unknown) =>
        log(
          `board-chat: waiting encrypted events could not be retried (${describe(error)})`,
        ),
      );
    },
    // Incoming first: it may queue answers behind the posts.
    idle: () => incoming.then(() => queue).then(() => undefined),

    onEvents(_txnId, events) {
      const woken = new Set<string>();
      for (const event of events) {
        // Decrypted before anything reads it: on the wire every encrypted event has this one
        // type, whatever it turns out to be.
        if (event.type === ENCRYPTED_EVENT_TYPE) {
          const room = encryptedInBoardRoom(event);
          if (room !== null) void inOrder(() => inbound(event, room));
          continue;
        }
        // An answer, before anything else: it answers the board, and nothing else may read it.
        if (routeAnswer(event)) continue;
        const member = membershipOf(event);
        if (member === null) continue;
        const room = store.boardRoomByRoomId(member.roomId);
        if (room === null) continue;
        store.recordMembership(member.roomId, member.userId, member.membership);
        if (member.membership === "join" && rooms.isPerson(member.userId)) {
          woken.add(room.boardId);
          // An admin an escalation invited: the open escalations they could not read, again.
          const invite = store.recordInviteJoined(room.boardId, member.userId);
          if (invite !== null) void repost(invite);
        }
      }
      for (const boardId of woken) postAll(boardId);
    },
  };
}

/** The membership an `m.room.member` event states, or null when it is not one. */
function membershipOf(
  event: MatrixEvent,
): { roomId: string; userId: string; membership: string } | null {
  if (event.type !== "m.room.member") return null;
  const { room_id: roomId, state_key: userId, content } = event;
  if (typeof roomId !== "string" || typeof userId !== "string") return null;
  if (typeof content !== "object" || content === null) return null;
  const membership = (content as { membership?: unknown }).membership;
  if (typeof membership !== "string") return null;
  return { roomId, userId, membership };
}
