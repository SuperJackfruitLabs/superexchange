/**
 * The way back for a delivery follow-up: a `dev.superpipeline.delivery.answer.v2` becomes a
 * recorded live link, or a switch to automatic delivery, at SuperPipeline, as the person who
 * answered, and one receipt says the board has it.
 *
 * Ported from the AgentPod hub's `services/board-chat/delivery-answer.ts` (`handleDeliveryAnswer`)
 * and the routing in `matrix-as/inbound.ts`. Parsing is treaty's (`parseDeliveryAnswer`); judging
 * an answer against what was RECORDED when the follow-up was posted (`followup_events`), and acting
 * on it, are this service's. Fails closed at every step (`card-answer.ts` for what every answer
 * shares): the gate id and the `m.reference` checked against each other and the room, then a
 * person, then the answer against the options the follow-up offered. The board judges it again on
 * its own terms (`POST /v1/boards/:boardId/gates/:gateId/delivery`).
 *
 * - `record_live_url` always takes a required `https://` link within the recorded limit, whatever
 *   was recorded about its input.
 * - `switch_to_automatic` only on a follow-up whose subject's preview was recorded complete, even
 *   if it was recorded as offered: an answer must never turn on posting what the card could not
 *   show.
 *
 * A follow-up with a receipt never reaches the board again.
 */
import {
  RECORD_LIVE_URL,
  SWITCH_TO_AUTOMATIC,
  inputRefusal,
  parseDeliveryAnswer,
  type InputRefusal,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { MatrixEvent } from "../appservice/index.ts";
import type { FollowupEvent, Store } from "../store/index.ts";
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
import { sendFollowupReceipt } from "./followup-card.ts";
import type { FollowupAnswerInput, ResolveResult } from "./superpipeline.ts";

export type FollowupAnswerRefusal =
  | "identity-unavailable"
  | "bad-option"
  | InputRefusal
  | "preview-incomplete"
  | "board-refused";

export type FollowupAnswerOutcome =
  | { status: "ignored"; reason: CardAnswerIgnored }
  | { status: "refused"; reason: FollowupAnswerRefusal; code?: string }
  | { status: "recorded"; change: "live-url" | "automatic" };

/** What the room is told for each refusal before the board (the hub's words). */
export const FOLLOWUP_REFUSAL_TEXT: Record<
  "bad-option" | InputRefusal | "preview-incomplete",
  string
> = {
  "bad-option":
    "That is not one of this follow-up's choices. Nothing has changed.",
  "input-required": "That needs the post's live link. Nothing has changed.",
  "text-too-long": "That link is too long. Nothing has changed.",
  "url-invalid":
    "That needs an https:// link to the live post. Nothing has changed.",
  "preview-incomplete":
    "The card could not show everything that would be posted, so automatic delivery cannot be turned on from here. Open the card on the board. Nothing has changed.",
};

export interface FollowupAnswersDeps extends CardAnswerDeps {
  store: Pick<
    Store,
    "boardRoomByRoomId" | "getBoard" | "followupEvent" | "claimFollowupReceipt"
  >;
  /** Record the link or switch the mode at SuperPipeline as the person (`answerFollowupAtSuperpipeline`). */
  answerFollowup(input: FollowupAnswerInput): Promise<ResolveResult>;
}

export interface FollowupAnswers {
  /** A delivery.answer.v2, by treaty's parse? */
  isAnswer(event: MatrixEvent): boolean;
  handle(event: MatrixEvent): Promise<FollowupAnswerOutcome>;
}

export function createFollowupAnswers(
  deps: FollowupAnswersDeps,
): FollowupAnswers {
  const { store, log } = deps;

  async function handle(event: MatrixEvent): Promise<FollowupAnswerOutcome> {
    if (event.type !== "m.room.message") return ignored("not-an-answer");
    const parsed = parseDeliveryAnswer(event.content);
    if (parsed === null) return ignored("not-an-answer");
    const where = inBoardRoom(store, event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;

    const at = `follow-up ${JSON.stringify(parsed.gateId.slice(0, 200))}`;
    const f = store.followupEvent(parsed.gateId);
    if (f === null || f.eventId === null) {
      log(`board-chat: an answer names ${at}, which was not posted; ignored`);
      return ignored("unknown-card");
    }
    // Both the gate and the reference, checked against each other, and the room: an answer sent
    // elsewhere cannot reach a follow-up by naming its message.
    if (parsed.referencedEventId !== f.eventId || roomId !== f.roomId) {
      log(
        `board-chat: an answer to ${at} references another event or room; ignored`,
      );
      return ignored("reference-mismatch");
    }
    const board = store.getBoard(f.boardId);
    if (board === null || !board.enabled) return ignored("board-disabled");
    if (f.outcomePostedAt !== null) return ignored("already-answered");

    const reply = replier(deps, "followup", event, roomId);
    const person = await personFor(deps, sender, at, reply);
    if ("ignored" in person) return ignored(person.ignored);
    if ("refused" in person) return refused(person.refused);

    const verdict = judge(parsed, f);
    if ("refusal" in verdict) {
      log(
        `board-chat: an answer to ${at} refused before the board (${verdict.refusal})`,
      );
      await reply(FOLLOWUP_REFUSAL_TEXT[verdict.refusal]);
      return refused(verdict.refusal);
    }

    const result = await deps.answerFollowup({
      boardId: f.boardId,
      gateId: f.gateId,
      change: verdict.change,
      principalId: person.id,
      senderMxid: sender,
    });
    if (!result.ok) {
      log(
        `board-chat: the board did not take an answer to ${at} (${result.code.slice(0, 64)})`,
      );
      await reply(boardRefusalText(result.code.slice(0, 64)));
      return refused("board-refused", result.code);
    }
    log(`board-chat: ${at} answered from chat on ${f.boardId}`);
    const change = "liveUrl" in verdict.change ? "live-url" : "automatic";
    // Claimed before it is said, so an answer delivered twice, or the sweep, leaves one.
    if (store.claimFollowupReceipt(f.gateId)) {
      try {
        await sendFollowupReceipt(
          deps.client,
          deps.speaker,
          f,
          change === "live-url" ? RECORD_LIVE_URL : SWITCH_TO_AUTOMATIC,
          person.label,
        );
      } catch (error) {
        // The board has the change by now: a receipt that cannot be posted must not undo that.
        log(
          `board-chat: ${at} answered, and its receipt could not be posted (${describe(error)})`,
        );
      }
    }
    return { status: "recorded", change };
  }

  return {
    isAnswer: (event) =>
      event.type === "m.room.message" &&
      parseDeliveryAnswer(event.content) !== null,
    handle,
  };
}

const ignored = (reason: CardAnswerIgnored): FollowupAnswerOutcome => ({
  status: "ignored",
  reason,
});

const refused = (
  reason: FollowupAnswerRefusal,
  code?: string,
): FollowupAnswerOutcome => ({
  status: "refused",
  reason,
  ...(code !== undefined ? { code: code.slice(0, 64) } : {}),
});

/** The board change an answer asks for, or why it must not be carried (the hub's `judge`). */
function judge(
  parsed: { optionId: string; text: string | null },
  f: FollowupEvent,
):
  | { change: { liveUrl: string } | { mode: "automatic" } }
  | { refusal: "bad-option" | InputRefusal | "preview-incomplete" } {
  const option = f.offer.options.find((o) => o.id === parsed.optionId);
  if (!option) return { refusal: "bad-option" };
  if (option.id === SWITCH_TO_AUTOMATIC) {
    // Offered only on a complete preview, and checked again here, whatever a client sent.
    if (f.offer.subjectPreviewComplete !== true)
      return { refusal: "preview-incomplete" };
    return { change: { mode: "automatic" } };
  }
  if (option.id !== RECORD_LIVE_URL) return { refusal: "bad-option" };
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX)
    return { refusal: "text-too-long" };
  // Whatever the recorded input says, a live link is a required https:// address.
  const why = inputRefusal(
    {
      kind: "url",
      required: true,
      max_length: option.input?.max_length ?? TEXT_READ_MAX,
    },
    parsed.text,
  );
  if (why || parsed.text === null) return { refusal: why ?? "input-required" };
  return { change: { liveUrl: parsed.text } };
}
