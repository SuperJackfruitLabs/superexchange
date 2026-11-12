/**
 * Board-room notices the event relay delivers: what SuperPipeline says about work already in a
 * board's room, which this service says there as a reply to the card it posted.
 *
 * Ported from the AgentPod hub's push routing (`routes/superpipeline-push.ts`): each CloudEvents
 * type is checked with the treaty predicate the hub uses, and its `event` must be the one the type
 * names, so a body of one kind delivered under another's type is refused.
 *
 * | CloudEvents type (`com.superjackfruit.superpipeline.…`) | treaty predicate         | notice              |
 * | ------------------------------------------------------- | ------------------------ | ------------------- |
 * | `decision.reminded.v1`                                  | `isDecisionTimeout`      | `reminded`          |
 * | `decision.escalated.v1`                                 | `isDecisionTimeout`      | `escalated`         |
 * | `gate.approval_recorded.v1`                             | `isGateApprovalRecorded` | `approval_recorded` |
 * | `decision.released.v1`                                  | `isDecisionReleased`     | `released`          |
 * | `decision.pulled_back.v1`                               | `isDecisionPulledBack`   | `pulled_back`       |
 * | `check.failed.v1`                                       | `isCheckFailed`          | `check_failed`      |
 * | `check.overridden.v1`                                   | `isCheckOverridden`      | `check_overridden`  |
 *
 * Kept only for a board an operator has opted in and not disabled, and only when there is
 * something true to say (the hub's rules, `decision-notices.ts`, `gate-progress.ts`,
 * `gate-hold.ts`, `check-notices.ts`):
 *
 * - **A card this service never posted is left alone.** A reminder, an escalation, a quorum
 *   gate's progress, a release or a pull-back is a reply: with nothing to reply to (posted before
 *   this service, still being sent, of another board or card) nothing is said and nobody is
 *   invited. A reminder, an escalation or progress on a card already settled says nothing
 *   either, since a reply to a decided card would read as though it were still open; a release
 *   or a pull-back follows a held approval's receipt, so it is said on a settled gate.
 * - **Checks have no card of their own.** A reminder of overdue checks stands alone, and their
 *   escalation posts one (`notice-post.ts`). A failed or overridden check is said in the board's
 *   room whether or not one was posted, as a reply when one is open.
 * - **The board's room.** A board with no room here says nothing.
 *
 * Recorded once under a key that makes a redelivery the same notice (`noticeKey`), so it is
 * accepted again without a second row; the same check failing on the card's next arrival is a new
 * notice. Posting is `notice-post.ts`.
 */
import { eventType } from "@superjackfruitlabs/treaty-cloudevents";
import {
  isCheckFailed,
  isCheckOverridden,
  isDecisionPulledBack,
  isDecisionReleased,
  isDecisionTimeout,
  isGateApprovalRecorded,
  type DecisionKind,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { NoticeInput, NoticeKind, Store } from "../store/index.ts";

const type = (entity: string, verb: string) =>
  eventType({ product: "superpipeline", entity, verb }, 1);

export const DECISION_REMINDED_V1 = type("decision", "reminded");
export const DECISION_ESCALATED_V1 = type("decision", "escalated");
export const GATE_APPROVAL_RECORDED_V1 = type("gate", "approval_recorded");
export const DECISION_RELEASED_V1 = type("decision", "released");
export const DECISION_PULLED_BACK_V1 = type("decision", "pulled_back");
export const CHECK_FAILED_V1 = type("check", "failed");
export const CHECK_OVERRIDDEN_V1 = type("check", "overridden");

interface NoticeType {
  notice: NoticeKind;
  /** The body's `event`, as SuperPipeline names it. */
  event: string;
  /** How a log and a refusal name it. */
  what: string;
  is(body: unknown): boolean;
}

/** Every notice the relay may deliver, by its CloudEvents type. */
export const NOTICE_TYPES: Readonly<Record<string, NoticeType>> = {
  [DECISION_REMINDED_V1]: {
    notice: "reminded",
    event: "decision.reminded",
    what: "reminder",
    is: isDecisionTimeout,
  },
  [DECISION_ESCALATED_V1]: {
    notice: "escalated",
    event: "decision.escalated",
    what: "escalation",
    is: isDecisionTimeout,
  },
  [GATE_APPROVAL_RECORDED_V1]: {
    notice: "approval_recorded",
    event: "gate.approval_recorded",
    what: "quorum approval",
    is: isGateApprovalRecorded,
  },
  [DECISION_RELEASED_V1]: {
    notice: "released",
    event: "decision.released",
    what: "release",
    is: isDecisionReleased,
  },
  [DECISION_PULLED_BACK_V1]: {
    notice: "pulled_back",
    event: "decision.pulled_back",
    what: "pull-back",
    is: isDecisionPulledBack,
  },
  [CHECK_FAILED_V1]: {
    notice: "check_failed",
    event: "check.failed",
    what: "failed check",
    is: isCheckFailed,
  },
  [CHECK_OVERRIDDEN_V1]: {
    notice: "check_overridden",
    event: "check.overridden",
    what: "overridden check",
    is: isCheckOverridden,
  },
};

/** The notice a CloudEvents type names, or undefined: only the table's own keys, never a prototype's. */
export function noticeTypeOf(type: string | undefined): NoticeType | undefined {
  return type !== undefined && Object.hasOwn(NOTICE_TYPES, type)
    ? NOTICE_TYPES[type]
    : undefined;
}

/** A hash of the parts, so ids that contain a separator can never make two notices one. */
export function hashKey(parts: unknown[]): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

type Body = Record<string, unknown> & { boardId: string; cardId: string };

/**
 * What makes a notice the same notice when it is delivered again (the hub's claim keys): a
 * reminder or an escalation per board, decision and notice; a quorum gate's approval per gate and
 * approver; a release or a pull-back per gate; a check's notice per board, card, arrival, notice
 * and check.
 */
export function noticeInputOf(notice: NoticeKind, b: Body): NoticeInput {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const base = { notice, boardId: b.boardId, cardId: b.cardId, body: b };
  switch (notice) {
    case "reminded":
    case "escalated":
      return {
        ...base,
        noticeId: hashKey([
          "decision",
          notice,
          b.boardId,
          b.decisionKind,
          b.decisionId,
        ]),
        decisionKind: str(b.decisionKind),
        decisionId: str(b.decisionId),
      };
    case "approval_recorded":
      return {
        ...base,
        noticeId: hashKey([
          "approval",
          b.gateId,
          (b.approval as { principalId?: unknown }).principalId,
        ]),
        decisionKind: null,
        decisionId: null,
      };
    case "released":
    case "pulled_back":
      return {
        ...base,
        noticeId: hashKey(["hold", b.gateId, notice]),
        decisionKind: null,
        decisionId: null,
      };
    case "check_failed":
    case "check_overridden":
      return {
        ...base,
        noticeId: hashKey([
          "check",
          b.boardId,
          b.cardId,
          b.arrivalId,
          notice,
          (b.check as { name?: unknown }).name,
        ]),
        decisionKind: null,
        decisionId: null,
      };
  }
}

/** The card this service posted for a decision, where it is and whether it is still open. */
export interface DecisionCard {
  roomId: string;
  /** The message a notice replies to. */
  eventId: string;
  open: boolean;
}

type CardStore = Pick<
  Store,
  | "gateEvent"
  | "gateDelivery"
  | "questionEvent"
  | "questionDelivery"
  | "followupEvent"
  | "attentionEvent"
  | "checksWaiting"
>;

const cardIdOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null
    ? (body as { cardId?: unknown }).cardId
    : undefined;

/**
 * The card this service posted for a decision on this board and card, or null when it posted
 * none (or it is still being sent). A check set's card is the checks.waiting card its escalation
 * posted. Ported from the hub's `cardEventFor`.
 */
export function decisionCard(
  store: CardStore,
  kind: DecisionKind | string,
  decisionId: string,
  boardId: string,
  cardId: string,
): DecisionCard | null {
  if (kind === "gate") {
    const g = store.gateEvent(decisionId);
    if (!g?.postedAt || g.boardId !== boardId) return null;
    if (cardIdOf(store.gateDelivery(decisionId)?.body) !== cardId) return null;
    const eventId = g.proseEventId ?? g.cardEventId;
    return eventId
      ? { roomId: g.roomId, eventId, open: g.outcomePostedAt === null }
      : null;
  }
  if (kind === "question") {
    const q = store.questionEvent(decisionId);
    if (!q?.postedAt || q.eventId === null || q.boardId !== boardId)
      return null;
    if (cardIdOf(store.questionDelivery(decisionId)?.body) !== cardId)
      return null;
    return {
      roomId: q.roomId,
      eventId: q.eventId,
      open: q.outcomePostedAt === null,
    };
  }
  if (kind === "delivery") {
    const f = store.followupEvent(decisionId);
    if (!f?.postedAt || f.eventId === null) return null;
    if (f.boardId !== boardId || f.cardId !== cardId) return null;
    return {
      roomId: f.roomId,
      eventId: f.eventId,
      open: f.outcomePostedAt === null,
    };
  }
  if (kind === "attention") {
    const a = store.attentionEvent({ boardId, cardId, waitId: decisionId });
    if (!a?.postedAt || a.eventId === null) return null;
    return {
      roomId: a.roomId,
      eventId: a.eventId,
      open: a.outcomePostedAt === null,
    };
  }
  if (kind === "checks") {
    const c = store.checksWaiting(boardId, decisionId);
    if (!c?.postedAt || c.eventId === null || c.cardId !== cardId) return null;
    return { roomId: c.roomId, eventId: c.eventId, open: c.closedAt === null };
  }
  return null;
}

/** Why a notice has nothing true to say. */
export type Unsayable =
  | "card not posted here"
  | "card settled"
  | "no room"
  | "card not in the board's room";

/**
 * Why a notice has nothing true to say now, or null when it may be said. The same rule at intake
 * and again before it is claimed, since a card may have been settled in between.
 */
export function unsayable(
  store: CardStore & Pick<Store, "boardRoom">,
  n: Pick<NoticeInput, "notice" | "boardId" | "cardId" | "body">,
): Unsayable | null {
  const room = store.boardRoom(n.boardId);
  if (room === null) return "no room";
  const b = n.body as Record<string, unknown>;
  if (n.notice === "reminded" || n.notice === "escalated") {
    // A check set waits before any gate opens: there is no card to reply to.
    if (b.decisionKind === "checks") return null;
    const card = decisionCard(
      store,
      String(b.decisionKind),
      String(b.decisionId),
      n.boardId,
      n.cardId,
    );
    if (card === null) return "card not posted here";
    if (!card.open) return "card settled";
    if (card.roomId !== room.roomId) return "card not in the board's room";
    return null;
  }
  if (
    n.notice === "approval_recorded" ||
    n.notice === "released" ||
    n.notice === "pulled_back"
  ) {
    const card = decisionCard(
      store,
      "gate",
      String(b.gateId),
      n.boardId,
      n.cardId,
    );
    if (card === null) return "card not posted here";
    if (card.roomId !== room.roomId) return "card not in the board's room";
    // Progress on a decided gate would read as though it were still open; a release or a
    // pull-back is what follows a held approval's receipt.
    if (n.notice === "approval_recorded" && !card.open) return "card settled";
    return null;
  }
  return null;
}

export type NoticeIntake =
  | {
      status: "accepted";
      noticeId: string;
      notice: NoticeKind;
      boardId: string;
      duplicate: boolean;
    }
  | {
      status: "ignored";
      reason: "board not opted in" | "board disabled" | Unsayable;
    }
  | { status: "invalid" };

/**
 * Keep a delivered notice for an opted-in board, when it has something true to say. `type` is a
 * key of `NOTICE_TYPES`; `body` is the event's data, unchecked.
 */
export function intakeNotice(
  store: CardStore &
    Pick<Store, "getBoard" | "boardRoom" | "notice" | "recordNotice">,
  type: string,
  body: unknown,
): NoticeIntake {
  const spec = noticeTypeOf(type);
  if (!spec || !spec.is(body)) return { status: "invalid" };
  const b = body as Body;
  if (b.event !== spec.event) return { status: "invalid" };
  const board = store.getBoard(b.boardId);
  if (board === null)
    return { status: "ignored", reason: "board not opted in" };
  if (!board.enabled) return { status: "ignored", reason: "board disabled" };
  const input = noticeInputOf(spec.notice, b);
  const accepted = (duplicate: boolean): NoticeIntake => ({
    status: "accepted",
    noticeId: input.noticeId,
    notice: input.notice,
    boardId: input.boardId,
    duplicate,
  });
  // Already recorded: a redelivery, whatever has happened to its card since.
  if (store.notice(input.noticeId) !== null) return accepted(true);
  const why = unsayable(store, input);
  if (why !== null) return { status: "ignored", reason: why };
  return accepted(!store.recordNotice(input));
}
