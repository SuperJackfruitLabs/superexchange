/**
 * Posting a delivered question into its board's room, exactly once, and closing it.
 *
 * Ported from the AgentPod hub's `services/board-chat/elicitations.ts` (`projectElicitation`,
 * the sweep's `settleElicitation`). A question is ONE event, built only by treaty: the prose
 * message (`m.room.message`) is the question.v2 (`questionV2Content`) and carries the v1 card
 * (`elicitationRequestCard`) under `ELICITATION_REQUEST_CONTENT_KEY`, so a v2 client and a v1
 * client read one event, and an answer references it. Everything is derived once from
 * `boundedQuestion`, so the prose, the card, question.v2 and what is recorded are the same
 * question.
 *
 * The order of a post is a gate's (`gate-card.ts`): the room made once; fail closed on
 * encryption (`room-sender.ts`); held until a person has joined, with no claim taken; the claim
 * (with what the question offers) before anything is sent; the send under a transaction id
 * derived from the question, so a retry of a claimed, unfinished question is answered by the
 * homeserver with the first send's event. Unlike the hub, a failed send keeps its claim: the next
 * join, boot or sweep sends it again under the same id, and the room never reads it twice.
 *
 * Closing (`settleQuestion`): the board no longer waits on it (answered on the board, or retired
 * by the agent's next question). Never posted, it never is; posted, one line says it is closed,
 * under the same receipt claim an answer in chat takes.
 */
import {
  ELICITATION_REQUEST_CONTENT_KEY,
  boundedQuestion,
  elicitationRequestCard,
  isApprovalRequest,
  isElicitationPending,
  questionFreeTextV2,
  questionOptionsV2,
  questionSubjectV2,
  questionV2Content,
  type ElicitationPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { BoardRoom, QuestionOffer, Store } from "../store/index.ts";
import type { RoomRefusal, RoomSender } from "./room-sender.ts";
import { describe, type BoardRooms } from "./rooms.ts";

/** What the room is told when the board no longer waits on a question (the hub's words). */
export const QUESTION_CLOSED_TEXT =
  "That question is closed — it was answered on the board, or the agent has moved on.";

/** The transaction id a question's event is sent under: the same on every try. */
export function questionTxnId(
  elicitationId: string,
  part: "prose" | "outcome",
): string {
  return `superexchange.question.${elicitationId}.${part}`;
}

/** What a question offers, exactly as the posted message carries it. Expects a `boundedQuestion`. */
export function questionOffer(d: ElicitationPendingDelivery): QuestionOffer {
  const subject = questionSubjectV2(d);
  return {
    options: d.options.map((o) => ({ id: o.id, label: o.label })),
    optionsV2: questionOptionsV2(d).map((o) => ({ ...o })),
    freeTextMaxLength: questionFreeTextV2(d)?.max_length ?? null,
    subject: subject
      ? {
          id: subject.id,
          digest: subject.digest,
          previewComplete: subject.preview_complete,
          expiresAt: readableExpiry(subject.expires_at),
        }
      : null,
    approvalRequest: isApprovalRequest(d),
  };
}

/** An expiry as ISO, or null when it is absent or unreadable: the board still judges it. */
function readableExpiry(iso: string | null): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export type QuestionPostOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "held"; roomId: string }
  | { status: "refused"; reason: RoomRefusal }
  | {
      status: "skipped";
      reason:
        | "not delivered"
        | "settled"
        | "not a question"
        | "board not opted in"
        | "board disabled";
    }
  | { status: "failed"; step: "room" | "membership" | "send" };

export interface QuestionPostDeps {
  store: Pick<
    Store,
    | "getBoard"
    | "questionDelivery"
    | "questionEvent"
    | "claimQuestionEvent"
    | "recordQuestionPosted"
    | "boardRoom"
    | "boardRoomByRoomId"
  >;
  sender: RoomSender;
  rooms: BoardRooms;
  /** Null when the room may be spoken in; else the refusal, logged once per board by the caller. */
  refuse(
    boardId: string,
    room: Pick<BoardRoom, "encrypted">,
  ): RoomRefusal | null;
  /** Log a question's hold once. */
  held(elicitationId: string, boardId: string): void;
  log: (line: string) => void;
}

/** Post one delivered question. Run only in board chat's queue. */
export async function postQuestion(
  deps: QuestionPostDeps,
  elicitationId: string,
): Promise<QuestionPostOutcome> {
  const { store, sender, rooms, log } = deps;
  const at = `question ${JSON.stringify(elicitationId)}`;
  const delivery = store.questionDelivery(elicitationId);
  if (delivery === null) return { status: "skipped", reason: "not delivered" };
  // The board stopped waiting on it before it was posted: never posted after.
  if (delivery.settledAt !== null)
    return { status: "skipped", reason: "settled" };
  if (!isElicitationPending(delivery.body))
    return { status: "skipped", reason: "not a question" };
  const d = boundedQuestion(delivery.body);
  const board = store.getBoard(d.boardId);
  if (board === null)
    return { status: "skipped", reason: "board not opted in" };
  if (!board.enabled) return { status: "skipped", reason: "board disabled" };

  const claimed = store.questionEvent(elicitationId);
  if (claimed?.postedAt) return { status: "already" };

  const known = claimed
    ? store.boardRoomByRoomId(claimed.roomId)
    : store.boardRoom(board.boardId);
  if (known) {
    const reason = deps.refuse(board.boardId, known);
    if (reason) return { status: "refused", reason };
  }

  let roomId: string;
  if (claimed) {
    roomId = claimed.roomId;
  } else {
    try {
      const room = await rooms.ensure(board, d.boardName ?? undefined);
      const reason = deps.refuse(board.boardId, room);
      if (reason) return { status: "refused", reason };
      roomId = room.roomId;
    } catch (error) {
      log(
        `board-chat: ${at} has no room on ${board.boardId} (${describe(error)})`,
      );
      return { status: "failed", step: "room" };
    }
    try {
      // Held before the claim: a held question has no row, so nothing typed in the room can be
      // taken as its answer.
      if (!(await rooms.personJoined(roomId))) {
        deps.held(elicitationId, board.boardId);
        return { status: "held", roomId };
      }
    } catch (error) {
      log(
        `board-chat: ${at} held: the room's members could not be read (${describe(error)})`,
      );
      return { status: "failed", step: "membership" };
    }
    store.claimQuestionEvent(
      elicitationId,
      board.boardId,
      roomId,
      questionOffer(d),
    );
  }

  const claim = store.questionEvent(elicitationId);
  if (claim === null) return { status: "failed", step: "send" };
  roomId = claim.roomId;
  try {
    const eventId = await sender.sendEvent(
      rooms.speaker,
      roomId,
      "m.room.message",
      questionTxnId(elicitationId, "prose"),
      {
        ...questionV2Content(d),
        [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d),
      },
    );
    store.recordQuestionPosted(elicitationId, eventId);
    log(`board-chat: ${at} posted on ${board.boardId}`);
    return { status: "posted", roomId, eventId };
  } catch (error) {
    // The claim stays: the next join, boot or sweep sends it under the same id.
    log(
      `board-chat: ${at} not posted on ${board.boardId} (${describe(error)}); it is retried at the next join, boot or sweep`,
    );
    return { status: "failed", step: "send" };
  }
}

/**
 * What closing a question the board no longer waits on came to: `settled` (its line claimed and
 * sent, or claimed and not sendable, logged), `withdrawn` (never posted, and now never will be),
 * `already` (it has its receipt), `refused` (its room may not be spoken in), `unknown`.
 */
export type QuestionSettleOutcome =
  | "settled"
  | "withdrawn"
  | "already"
  | "refused"
  | "unknown";

export interface QuestionSettleDeps {
  store: Pick<
    Store,
    | "questionDelivery"
    | "questionEvent"
    | "settleQuestionDelivery"
    | "settleQuestionEvent"
    | "boardRoomByRoomId"
  >;
  sender: Pick<RoomSender, "sendEvent" | "refusal">;
  speaker: string;
  log: (line: string) => void;
}

/** Close a question the board no longer waits on. Run only in board chat's queue. */
export async function settleQuestion(
  deps: QuestionSettleDeps,
  elicitationId: string,
): Promise<QuestionSettleOutcome> {
  const { store } = deps;
  const delivery = store.questionDelivery(elicitationId);
  const question = store.questionEvent(elicitationId);
  if (delivery === null && question === null) return "unknown";
  store.settleQuestionDelivery(elicitationId);
  if (question === null || question.postedAt === null) return "withdrawn";
  const room = store.boardRoomByRoomId(question.roomId);
  if (room === null || deps.sender.refusal(room) !== null) return "refused";
  // Claimed first: posting before claiming would let two passes both post and one record it.
  if (!store.settleQuestionEvent(elicitationId)) return "already";
  try {
    await deps.sender.sendEvent(
      deps.speaker,
      question.roomId,
      "m.room.message",
      questionTxnId(elicitationId, "outcome"),
      { msgtype: "m.text", body: QUESTION_CLOSED_TEXT },
    );
  } catch (error) {
    deps.log(
      `board-chat: question ${JSON.stringify(elicitationId)} is closed on the board, and the room could not be told (${describe(error)})`,
    );
  }
  return "settled";
}
