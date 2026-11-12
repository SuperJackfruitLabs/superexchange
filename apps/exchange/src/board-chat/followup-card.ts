/**
 * Posting a delivered follow-up into its board's room, exactly once, and its receipt.
 *
 * Ported from the AgentPod hub's `services/board-chat/delivery-projection.ts` (`projectDelivery`)
 * and `delivery-answer.ts` (`settleDeliveryOutcome`). A follow-up is ONE event, built only by
 * treaty: `deliveryV2Content`, an `m.room.message` carrying `dev.superpipeline.delivery.v2`, with
 * the approved post's exact preview and the two choices (record the live link, or switch to
 * automatic delivery, offered only on a complete preview). What it offers is recorded with the
 * claim (`followupOffer`), because an answer is judged against that and nothing else. The post
 * itself is `card-post.ts`: held until a person has joined, fail closed on encryption, claimed
 * before the send, one transaction id on every try.
 *
 * Its receipt is the gate's own (charter §3: a follow-up "is settled by a receipt, like a gate"):
 * a prose line and `dev.superpipeline.gate.outcome.v1` pointing at the follow-up's message, built
 * by treaty (`deliveryOutcomeContent`). One per follow-up: the answer path claims it
 * (`claimFollowupReceipt`) and the sweep claims it (`settleFollowupEvent`) on the same column, so a
 * follow-up answered in chat and then seen settled has one receipt.
 */
import {
  GATE_OUTCOME_TYPE,
  RECORD_LIVE_URL,
  SWITCH_TO_AUTOMATIC,
  deliveryOptionsV2,
  deliveryOutcomeContent,
  deliverySubjectV2,
  deliveryV2Content,
  isDeliveryPending,
  type DeliveryOutcomeDecision,
  type DeliveryPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { FollowupEvent, FollowupOffer, Store } from "../store/index.ts";
import {
  postCard,
  type CardPostDeps,
  type CardPostOutcome,
} from "./card-post.ts";
import type { RoomSender } from "./room-sender.ts";
import { describe } from "./rooms.ts";

/** The transaction id a follow-up's event is sent under: the same on every try. */
export function followupTxnId(
  gateId: string,
  part: "prose" | "outcome.prose" | "outcome.card",
): string {
  return `superexchange.followup.${gateId}.${part}`;
}

/** What a follow-up offers, exactly as its delivery.v2 carries it. */
export function followupOffer(d: DeliveryPendingDelivery): FollowupOffer {
  return {
    options: deliveryOptionsV2(d).map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.input
        ? {
            input: {
              kind: o.input.kind,
              required: o.input.required,
              max_length: o.input.max_length,
            },
          }
        : {}),
    })),
    subjectPreviewComplete: deliverySubjectV2(d)?.preview_complete ?? null,
  };
}

export type FollowupPostOutcome =
  | CardPostOutcome
  | {
      status: "skipped";
      reason:
        | "not delivered"
        | "settled"
        | "not a follow-up"
        | "board not opted in"
        | "board disabled";
    };

export interface FollowupPostDeps extends Omit<CardPostDeps, "store"> {
  store: Pick<
    Store,
    | "getBoard"
    | "followupDelivery"
    | "followupEvent"
    | "claimFollowupEvent"
    | "recordFollowupPosted"
    | "boardRoom"
    | "boardRoomByRoomId"
  >;
}

/** Post one delivered follow-up. Run only in board chat's queue. */
export async function postFollowup(
  deps: FollowupPostDeps,
  gateId: string,
): Promise<FollowupPostOutcome> {
  const { store } = deps;
  const delivery = store.followupDelivery(gateId);
  if (delivery === null) return { status: "skipped", reason: "not delivered" };
  // The board stopped owing it before it was posted: never posted after.
  if (delivery.settledAt !== null)
    return { status: "skipped", reason: "settled" };
  const d = delivery.body;
  if (!isDeliveryPending(d))
    return { status: "skipped", reason: "not a follow-up" };
  const board = store.getBoard(d.boardId);
  if (board === null)
    return { status: "skipped", reason: "board not opted in" };
  if (!board.enabled) return { status: "skipped", reason: "board disabled" };
  return postCard(deps, {
    at: `follow-up ${JSON.stringify(gateId)}`,
    heldKey: `followup\u0000${gateId}`,
    board,
    boardName: d.boardName ?? null,
    claimed: () => store.followupEvent(gateId),
    claim: (roomId) =>
      store.claimFollowupEvent(
        gateId,
        board.boardId,
        d.cardId,
        roomId,
        followupOffer(d),
      ),
    recordPosted: (eventId) => store.recordFollowupPosted(gateId, eventId),
    txnId: followupTxnId(gateId, "prose"),
    content: () => deliveryV2Content(d),
  });
}

const RECEIPT_WORDS: Record<DeliveryOutcomeDecision, string> = {
  [RECORD_LIVE_URL]: "Live link recorded",
  [SWITCH_TO_AUTOMATIC]: "Switched to automatic delivery",
  settled_elsewhere: "Settled on the board",
};

/** The prose line of a follow-up's receipt (the hub's words). */
export function followupReceiptBody(
  decision: DeliveryOutcomeDecision,
  decidedBy: string | null,
): string {
  const what = RECEIPT_WORDS[decision];
  return decidedBy
    ? `${what} by ${decidedBy} — the board has it.`
    : `${what} — the board has it.`;
}

/**
 * Send a follow-up's receipt, already claimed: the prose line, then the gate outcome at the
 * follow-up's message. Each under its own transaction id, so a retry is the same message.
 */
export async function sendFollowupReceipt(
  sender: Pick<RoomSender, "sendEvent">,
  speaker: string,
  f: Pick<FollowupEvent, "gateId" | "boardId" | "roomId" | "eventId">,
  decision: DeliveryOutcomeDecision,
  decidedBy: string | null,
): Promise<void> {
  await sender.sendEvent(
    speaker,
    f.roomId,
    "m.room.message",
    followupTxnId(f.gateId, "outcome.prose"),
    { msgtype: "m.text", body: followupReceiptBody(decision, decidedBy) },
  );
  await sender.sendEvent(
    speaker,
    f.roomId,
    GATE_OUTCOME_TYPE,
    followupTxnId(f.gateId, "outcome.card"),
    deliveryOutcomeContent(
      f.gateId,
      { boardId: f.boardId, eventId: f.eventId ?? "" },
      decision,
      decidedBy,
    ),
  );
}

/**
 * What settling a follow-up the board no longer owes came to: `settled` (its receipt claimed and
 * sent, or claimed and not sendable, logged), `withdrawn` (never posted, and now never will be),
 * `already` (it has its receipt), `refused` (its room may not be spoken in), `unknown`.
 */
export type FollowupSettleOutcome =
  | "settled"
  | "withdrawn"
  | "already"
  | "refused"
  | "unknown";

export interface FollowupSettleDeps {
  store: Pick<
    Store,
    | "followupDelivery"
    | "followupEvent"
    | "settleFollowupDelivery"
    | "settleFollowupEvent"
    | "boardRoomByRoomId"
  >;
  sender: Pick<RoomSender, "sendEvent" | "refusal">;
  speaker: string;
  log: (line: string) => void;
}

/**
 * Settle a follow-up the board no longer lists (the link recorded on the web, the mode switched,
 * the approval expired): its receipt once, naming nobody, if it is in a room; never posted if it
 * is not. Run only in board chat's queue.
 */
export async function settleFollowup(
  deps: FollowupSettleDeps,
  gateId: string,
): Promise<FollowupSettleOutcome> {
  const { store } = deps;
  const delivery = store.followupDelivery(gateId);
  const f = store.followupEvent(gateId);
  if (delivery === null && f === null) return "unknown";
  store.settleFollowupDelivery(gateId);
  if (f === null || f.postedAt === null) return "withdrawn";
  const room = store.boardRoomByRoomId(f.roomId);
  if (room === null || deps.sender.refusal(room) !== null) return "refused";
  // Claimed first: posting before claiming would let two passes both post and one record it.
  if (!store.settleFollowupEvent(gateId)) return "already";
  try {
    await sendFollowupReceipt(
      deps.sender,
      deps.speaker,
      f,
      "settled_elsewhere",
      null,
    );
  } catch (error) {
    deps.log(
      `board-chat: follow-up ${JSON.stringify(gateId)} is settled on the board, and its receipt could not be posted (${describe(error)})`,
    );
  }
  return "settled";
}
