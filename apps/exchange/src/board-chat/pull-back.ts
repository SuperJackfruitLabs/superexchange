/**
 * Pulling a held approval back, and overriding a machine check, from chat: a
 * `dev.superpipeline.gate.pull_back.v2` or a `dev.superpipeline.check.override.v2` becomes the
 * board's route, called as the person who sent it, with the organization plane's assertion, exactly
 * as a decision is carried.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-pull-back.ts` (`handleGatePullBack`) and
 * `check-override.ts` (`handleCheckOverride`), and the routing in `matrix-as/inbound.ts`: each is
 * matched by its marker alone, so a malformed one is refused here rather than read as a typed reply.
 * Parsing is treaty's (`parsePullBack`, `parseCheckOverride`). Fails closed at every step:
 *
 * - **pull-back**: the gate must be one this service posted, in this room, and the message must
 *   reference its prose or its card (`m.reference`);
 * - **override**: the message must reference a checks.waiting card this service posted
 *   (`notice-post.ts`), and the room, board and card it names must be that card's;
 *
 * then attribution (`card-answer.ts`: silent for an unlinked sender or an agent, the plane being
 * unreachable said); then the comment the board requires, within its bound. The board judges who
 * may (a decider of the gate or an owner or admin; an owner or admin for a check, never the producer
 * of the work) and whether it is still possible, and its refusal is said in the room.
 *
 * Success says nothing here: the board publishes `decision.pulled_back` or `check.overridden`, and
 * `notice-post.ts` says it in the room from that, once, however it was done.
 */
import {
  CHECK_OVERRIDE_COMMENT_MAX_BYTES,
  CHECK_OVERRIDE_V2_SUITE_TYPE,
  GATE_PULL_BACK_V2_SUITE_TYPE,
  PULL_BACK_COMMENT_MAX_BYTES,
  checkOverrideCommentFits,
  parseCheckOverride,
  parsePullBack,
  pullBackCommentFits,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { MatrixEvent } from "../appservice/index.ts";
import type { Store } from "../store/index.ts";
import {
  boardRefusalText,
  inBoardRoom,
  personFor,
  replier,
  type CardAnswerDeps,
  type CardAnswerIgnored,
} from "./card-answer.ts";
import type {
  CheckOverrideInput,
  PullBackInput,
  ResolveResult,
} from "./superpipeline.ts";

/** Said when a pull-back carries no comment; the board would refuse it `INVALID_COMMENT`. */
export const PULL_BACK_COMMENT_REQUIRED_TEXT =
  "Pulling back an approval needs a comment saying why. Nothing has changed.";
/** Said when an override carries no comment. */
export const CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT =
  "Overriding a check needs a comment saying why. Nothing has changed.";

/**
 * What a refusal any person-carried board call can meet becomes in the room (the hub's
 * `boardCallRefusalText`).
 */
export function boardCallRefusalText(code: string): string {
  switch (code) {
    case "INVALID_COMMENT":
      return "The board did not take that comment: it needs a short one saying why. Nothing has changed.";
    case "UNREACHABLE":
      return "That did not reach the board. Try again in a moment. Nothing has changed.";
    default:
      return boardRefusalText(code);
  }
}

/** What the board's refusal of a pull-back becomes in the room (the hub's words). */
export function pullBackRefusalText(code: string): string {
  switch (code) {
    case "APPROVAL_RELEASED":
      return "Too late to pull back: this approval has already gone ahead. Nothing has changed.";
    case "GATE_NOT_HELD":
      return "There is nothing to pull back: this approval is not waiting for its release time. Nothing has changed.";
    case "APPROVAL_DECIDER_NOT_ALLOWED":
      return "Only someone who may decide this gate, or a workspace owner or admin, can pull it back. Nothing has changed.";
    case "SEPARATION_OF_DUTIES":
      return "You produced this work, so you can't pull back its approval. Nothing has changed.";
    default:
      return boardCallRefusalText(code);
  }
}

/** What the board's refusal of an override becomes in the room (the hub's words). */
export function checkOverrideRefusalText(code: string): string {
  switch (code) {
    case "CHECK_OVERRIDE_NOT_ALLOWED":
      return "Only a workspace owner or admin can override a check. Nothing has changed.";
    case "SEPARATION_OF_DUTIES":
      return "You produced this work, so you can't override a check on it. Nothing has changed.";
    case "CHECK_NOT_OPEN":
      return "That check can't be overridden now: it already passed or was overridden, or the card has moved on. Nothing has changed.";
    case "CHECK_NOT_FOUND":
      return "There is no check by that name waiting on this card. Nothing has changed.";
    case "CARD_NOT_FOUND":
      return "That card is no longer on the board. Nothing has changed.";
    default:
      return boardCallRefusalText(code);
  }
}

export type PersonCallRefusal =
  | "identity-unavailable"
  | "comment-required"
  | "comment-too-long"
  | "board-refused";

export type PersonCallOutcome =
  | {
      status: "ignored";
      reason: CardAnswerIgnored | "not-a-pull-back" | "not-an-override";
    }
  | { status: "refused"; reason: PersonCallRefusal; code?: string }
  | { status: "pulled-back" }
  | { status: "overridden" };

export interface PullBacksDeps extends CardAnswerDeps {
  store: Pick<Store, "boardRoomByRoomId" | "getBoard" | "gateEvent">;
  /** The board's pull-back route, called as the person (`pullBackAtSuperpipeline`). */
  pullBack(input: PullBackInput): Promise<ResolveResult>;
}

export interface CheckOverridesDeps extends CardAnswerDeps {
  store: Pick<Store, "boardRoomByRoomId" | "getBoard" | "checksWaitingByEvent">;
  /** The board's override route, called as the person (`overrideCheckAtSuperpipeline`). */
  override(input: CheckOverrideInput): Promise<ResolveResult>;
}

export interface MarkedAnswers {
  /** Carries this marker? Matched on the marker alone, so a malformed one never reaches a typed reply. */
  isAnswer(event: MatrixEvent): boolean;
  handle(event: MatrixEvent): Promise<PersonCallOutcome>;
}

const marked = (event: MatrixEvent, type: string) =>
  event.type === "m.room.message" &&
  typeof event.content === "object" &&
  event.content !== null &&
  (event.content as { suite_event_type?: unknown }).suite_event_type === type;

const ignored = (
  reason: Extract<PersonCallOutcome, { status: "ignored" }>["reason"],
): PersonCallOutcome => ({
  status: "ignored",
  reason,
});

/** The comment rule both share: required, then within the board's bound; said after attribution. */
async function commentRefusal(
  comment: string | null,
  fits: (c: string) => boolean,
  max: number,
  required: string,
  reply: (body: string) => Promise<unknown>,
): Promise<PersonCallOutcome | null> {
  if (comment === null) {
    await reply(required);
    return { status: "refused", reason: "comment-required" };
  }
  if (!fits(comment)) {
    await reply(
      `That comment is longer than the board takes (at most ${max} bytes). Nothing has changed.`,
    );
    return { status: "refused", reason: "comment-too-long" };
  }
  return null;
}

export function createPullBacks(deps: PullBacksDeps): MarkedAnswers {
  const { store, log } = deps;
  async function handle(event: MatrixEvent): Promise<PersonCallOutcome> {
    if (!marked(event, GATE_PULL_BACK_V2_SUITE_TYPE))
      return ignored("not-a-pull-back");
    const parsed = parsePullBack(event.content);
    if (parsed === null) return ignored("not-a-pull-back");
    const where = inBoardRoom(store, event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;
    const at = `gate ${JSON.stringify(parsed.gateId.slice(0, 200))}`;
    const gate = store.gateEvent(parsed.gateId);
    if (gate === null) {
      log(
        `board-chat: a pull-back names ${at}, which was not posted here; ignored`,
      );
      return ignored("unknown-card");
    }
    // Both identifiers, checked against each other and the room: trusting the reference alone
    // would act on whatever gate a sender pointed at.
    const ref = parsed.referencedEventId;
    const matches =
      ref !== null && (ref === gate.cardEventId || ref === gate.proseEventId);
    if (!matches || roomId !== gate.roomId) {
      log(
        `board-chat: a pull-back of ${at} references another event or room; ignored`,
      );
      return ignored("reference-mismatch");
    }
    const board = store.getBoard(gate.boardId);
    if (board === null || !board.enabled) return ignored("board-disabled");

    const reply = replier(deps, "pullback", event, roomId);
    const person = await personFor(deps, sender, at, reply);
    if ("ignored" in person) return ignored(person.ignored);
    if ("refused" in person)
      return { status: "refused", reason: person.refused };
    // After attribution, so a stranger or an agent cannot make this service speak.
    const bad = await commentRefusal(
      parsed.comment,
      pullBackCommentFits,
      PULL_BACK_COMMENT_MAX_BYTES,
      PULL_BACK_COMMENT_REQUIRED_TEXT,
      reply,
    );
    if (bad) return bad;
    const result = await deps.pullBack({
      boardId: gate.boardId,
      gateId: parsed.gateId,
      comment: parsed.comment as string,
      principalId: person.id,
      senderMxid: sender,
    });
    if (!result.ok) {
      const code = result.code.slice(0, 64);
      log(`board-chat: the board did not take a pull-back of ${at} (${code})`);
      await reply(pullBackRefusalText(code));
      return { status: "refused", reason: "board-refused", code };
    }
    log(
      `board-chat: a held approval of ${at} was pulled back from chat; the board's event says it`,
    );
    return { status: "pulled-back" };
  }
  return { isAnswer: (e) => marked(e, GATE_PULL_BACK_V2_SUITE_TYPE), handle };
}

export function createCheckOverrides(deps: CheckOverridesDeps): MarkedAnswers {
  const { store, log } = deps;
  async function handle(event: MatrixEvent): Promise<PersonCallOutcome> {
    if (!marked(event, CHECK_OVERRIDE_V2_SUITE_TYPE))
      return ignored("not-an-override");
    const parsed = parseCheckOverride(event.content);
    if (parsed === null) return ignored("not-an-override");
    const where = inBoardRoom(store, event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;
    // The reference is the only way to the card; then every identifier the message names is
    // checked against what was recorded, and the room against where it was posted.
    const card = parsed.referencedEventId
      ? store.checksWaitingByEvent(parsed.referencedEventId)
      : null;
    if (card === null) {
      log(
        "board-chat: a check override references no checks card posted here; ignored",
      );
      return ignored("unknown-card");
    }
    if (
      card.roomId !== roomId ||
      card.boardId !== parsed.boardId ||
      card.cardId !== parsed.cardId
    ) {
      log(
        `board-chat: a check override on ${card.boardId} names another room, board or card; ignored`,
      );
      return ignored("reference-mismatch");
    }
    const board = store.getBoard(card.boardId);
    if (board === null || !board.enabled) return ignored("board-disabled");
    const at = `a check on ${card.boardId}`;

    const reply = replier(deps, "override", event, roomId);
    const person = await personFor(deps, sender, at, reply);
    if ("ignored" in person) return ignored(person.ignored);
    if ("refused" in person)
      return { status: "refused", reason: person.refused };
    const bad = await commentRefusal(
      parsed.comment,
      checkOverrideCommentFits,
      CHECK_OVERRIDE_COMMENT_MAX_BYTES,
      CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT,
      reply,
    );
    if (bad) return bad;
    const result = await deps.override({
      boardId: card.boardId,
      cardId: card.cardId,
      checkName: parsed.checkName,
      comment: parsed.comment as string,
      principalId: person.id,
      senderMxid: sender,
    });
    if (!result.ok) {
      const code = result.code.slice(0, 64);
      log(`board-chat: the board did not take an override of ${at} (${code})`);
      await reply(checkOverrideRefusalText(code));
      return { status: "refused", reason: "board-refused", code };
    }
    log(
      `board-chat: ${at} was overridden from chat; the board's event says it`,
    );
    return { status: "overridden" };
  }
  return { isAnswer: (e) => marked(e, CHECK_OVERRIDE_V2_SUITE_TYPE), handle };
}
