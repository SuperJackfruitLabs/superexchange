/**
 * The way back for a waiting card: a `dev.superpipeline.attention.answer.v2` becomes a resume
 * (here, or at an earlier stage) or an archive at SuperPipeline, as the person who answered, naming
 * the wait they were shown, and one receipt says the board has it.
 *
 * Ported from the AgentPod hub's `services/board-chat/attention-answer.ts` (`handleAttentionAnswer`)
 * and the routing in `matrix-as/inbound.ts`. Parsing is treaty's (`parseAttentionAnswer`); judging
 * an answer against what was RECORDED when the card was posted (`attention_events`), and acting on
 * it, are this service's. Fails closed at every step (`card-answer.ts` for what every answer
 * shares): the wait (board, card, wait id) and the `m.reference` checked against each other and the
 * room, then a person, then the answer against the options the card offered. The board judges it
 * again (`POST /v1/boards/:boardId/cards/:cardId/resume` or `…/archive`, with `expectedWaitId`),
 * including who may work the board, which only it knows.
 *
 * - A resume always takes a required instruction, at most `ATTENTION_COMMENT_MAX` characters (or
 *   the recorded input's limit, if lower), whatever was recorded about its input.
 * - An archive takes nothing; a remark the person added rides as the board's optional comment.
 * - `WAIT_CHANGED` (the board says the card is no longer waiting on that wait) is said in plain
 *   words, and the card is closed with its structured outcome only, as settled elsewhere.
 *
 * A card with a receipt never reaches the board again.
 */
import {
  ATTENTION_COMMENT_MAX,
  SETTLED_ELSEWHERE,
  attentionAction,
  inputRefusal,
  parseAttentionAnswer,
  type ParsedAttentionAnswer,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { MatrixEvent } from "../appservice/index.ts";
import type { AttentionEvent, Store } from "../store/index.ts";
import { waitKeyOf } from "./attention.ts";
import { sendAttentionReceipt, waitLabel } from "./attention-card.ts";
import {
  TEXT_READ_MAX,
  boardRefusalText,
  describe,
  inBoardRoom,
  personFor,
  replier,
  type CardAnswerDeps,
  type CardAnswerIgnored,
} from "./card-answer.ts";
import type {
  AttentionAction,
  AttentionAnswerInput,
  ResolveResult,
} from "./superpipeline.ts";

export type AttentionAnswerRefusal =
  | "identity-unavailable"
  | "bad-option"
  | "input-required"
  | "text-too-long"
  | "board-refused";

export type AttentionAnswerOutcome =
  | { status: "ignored"; reason: CardAnswerIgnored }
  | { status: "refused"; reason: AttentionAnswerRefusal; code?: string }
  | { status: "done"; decision: string };

/** Said when the board refuses a stale wait; the card is then closed as settled elsewhere. */
export const WAIT_CHANGED_TEXT =
  "This card is no longer waiting on that — it was resumed, archived or moved on the board, or it is waiting on something else now. Nothing has changed.";

const REFUSAL_TEXT = {
  "bad-option": "That is not one of this card's choices. Nothing has changed.",
  "input-required":
    "Resuming needs an instruction for the next attempt. Nothing has changed.",
} as const;

/** The board's refusals of a waiting card's answer, in words (the hub's `boardRefusalText`). */
const BOARD_TEXT: Record<string, string> = {
  FORBIDDEN:
    "The board says you can't do that: it needs someone who may work this board. Nothing has changed.",
  HTTP_403:
    "The board says you can't do that: it needs someone who may work this board. Nothing has changed.",
  QUESTION_PENDING:
    "The card has a question waiting. Answer that first. Nothing has changed.",
  GATE_PENDING:
    "The card has a review waiting. Decide that first. Nothing has changed.",
  INVALID_RESUME:
    "The board can't resume the card there. Open it on the board. Nothing has changed.",
  UNREACHABLE:
    "That did not reach the board. Try again in a moment. Nothing has changed.",
};

export interface AttentionAnswersDeps extends CardAnswerDeps {
  store: Pick<
    Store,
    | "boardRoomByRoomId"
    | "getBoard"
    | "attentionEvent"
    | "claimAttentionReceipt"
  >;
  /** Resume or archive at SuperPipeline as the person (`answerAttentionAtSuperpipeline`). */
  answerAttention(input: AttentionAnswerInput): Promise<ResolveResult>;
}

export interface AttentionAnswers {
  /** An attention.answer.v2, by treaty's parse? */
  isAnswer(event: MatrixEvent): boolean;
  handle(event: MatrixEvent): Promise<AttentionAnswerOutcome>;
}

export function createAttentionAnswers(
  deps: AttentionAnswersDeps,
): AttentionAnswers {
  const { store, log } = deps;

  /** The receipt, claimed before it is said, so a double tap or the sweep leaves one. */
  async function receipt(
    card: AttentionEvent,
    decision: string,
    decidedBy: string | null,
    prose: boolean,
  ): Promise<void> {
    if (!store.claimAttentionReceipt(waitKeyOf(card))) return;
    try {
      await sendAttentionReceipt(
        deps.client,
        deps.speaker,
        card,
        decision,
        decidedBy,
        { prose },
      );
    } catch (error) {
      log(
        `board-chat: ${waitLabel(card)} is settled, and its receipt could not be posted (${describe(error)})`,
      );
    }
  }

  async function handle(event: MatrixEvent): Promise<AttentionAnswerOutcome> {
    if (event.type !== "m.room.message") return ignored("not-an-answer");
    const parsed = parseAttentionAnswer(event.content);
    if (parsed === null) return ignored("not-an-answer");
    const where = inBoardRoom(store, event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;

    const key = waitKeyOf(parsed);
    const at = waitLabel({
      boardId: key.boardId,
      cardId: key.cardId.slice(0, 200),
      waitId: key.waitId.slice(0, 200),
    });
    const card = store.attentionEvent(key);
    if (card === null || card.eventId === null) {
      log(`board-chat: an answer names ${at}, which was not posted; ignored`);
      return ignored("unknown-card");
    }
    // The wait and the reference, checked against each other, and the room: an answer naming
    // another wait of the same card, or sent elsewhere, never reaches this one.
    if (parsed.referencedEventId !== card.eventId || roomId !== card.roomId) {
      log(
        `board-chat: an answer to ${at} references another event or room; ignored`,
      );
      return ignored("reference-mismatch");
    }
    const board = store.getBoard(card.boardId);
    if (board === null || !board.enabled) return ignored("board-disabled");
    if (card.outcomePostedAt !== null) return ignored("already-answered");

    const reply = replier(deps, "attention", event, roomId);
    const person = await personFor(deps, sender, at, reply);
    if ("ignored" in person) return ignored(person.ignored);
    if ("refused" in person) return refused(person.refused);

    const verdict = judge(parsed, card);
    if ("refusal" in verdict) {
      log(
        `board-chat: an answer to ${at} refused before the board (${verdict.refusal})`,
      );
      await reply(
        verdict.refusal === "text-too-long"
          ? `That is longer than the board takes (at most ${verdict.limit} characters). Nothing has changed.`
          : REFUSAL_TEXT[verdict.refusal],
      );
      return refused(verdict.refusal);
    }

    const result = await deps.answerAttention({
      ...key,
      action: verdict.action,
      principalId: person.id,
      senderMxid: sender,
    });
    if (!result.ok) {
      const code = result.code.slice(0, 64);
      log(`board-chat: the board did not take an answer to ${at} (${code})`);
      if (code === "WAIT_CHANGED") {
        // The wait the person was shown has ended: said in words, and the card closed with its
        // structured outcome only (no second line).
        await reply(WAIT_CHANGED_TEXT);
        await receipt(card, SETTLED_ELSEWHERE, null, false);
        return refused("board-refused", code);
      }
      await reply(BOARD_TEXT[code] ?? boardRefusalText(code));
      return refused("board-refused", code);
    }
    log(`board-chat: ${at} answered from chat on ${card.boardId}`);
    await receipt(card, parsed.optionId, person.label, true);
    return { status: "done", decision: parsed.optionId };
  }

  return {
    isAnswer: (event) =>
      event.type === "m.room.message" &&
      parseAttentionAnswer(event.content) !== null,
    handle,
  };
}

const ignored = (reason: CardAnswerIgnored): AttentionAnswerOutcome => ({
  status: "ignored",
  reason,
});

const refused = (
  reason: AttentionAnswerRefusal,
  code?: string,
): AttentionAnswerOutcome => ({
  status: "refused",
  reason,
  ...(code !== undefined ? { code: code.slice(0, 64) } : {}),
});

/** The board call an answer asks for, or why it must not be carried (the hub's `judge`). */
function judge(
  parsed: ParsedAttentionAnswer,
  card: AttentionEvent,
):
  | { action: AttentionAction }
  | { refusal: "bad-option" | "input-required" }
  | { refusal: "text-too-long"; limit: number } {
  const option = card.options.find((o) => o.id === parsed.optionId);
  const action = option ? attentionAction(option.id) : null;
  if (!option || !action) return { refusal: "bad-option" };
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX)
    return { refusal: "text-too-long", limit: ATTENTION_COMMENT_MAX };
  if (action.kind === "archive") {
    if (parsed.text !== null && parsed.text.length > ATTENTION_COMMENT_MAX)
      return { refusal: "text-too-long", limit: ATTENTION_COMMENT_MAX };
    return { action: { kind: "archive", comment: parsed.text } };
  }
  // Whatever the recorded input says, a resume takes a required instruction within the board's limit.
  const max = Math.min(
    option.input?.max_length ?? ATTENTION_COMMENT_MAX,
    ATTENTION_COMMENT_MAX,
  );
  const why = inputRefusal(
    { kind: "text", required: true, max_length: max },
    parsed.text,
  );
  if (why === "text-too-long") return { refusal: "text-too-long", limit: max };
  if (why || parsed.text === null) return { refusal: "input-required" };
  return {
    action: {
      kind: "resume",
      toStageKey: action.toStageKey,
      comment: parsed.text,
    },
  };
}
