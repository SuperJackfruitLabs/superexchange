/**
 * Waiting cards the event relay delivers: a card parked for a person for a reason other than a
 * question or a review, such as repeated failure, blocked or not authorised (`attention.pending`
 * v1, charter: "Waiting cards and broker approvals reach chat" §1). Checked with treaty's
 * `isAttentionPending`, the predicate the AgentPod hub uses, and kept only for a board an operator
 * has opted in and not disabled, as gates are (`gates.ts`).
 *
 * Recorded once per wait (board, card and wait id): a card that parks again is a new wait, and a
 * new card in the room.
 */
import { eventType } from "@superjackfruitlabs/treaty-cloudevents";
import { isAttentionPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store, WaitKey } from "../store/index.ts";

/** The CloudEvents type SuperPipeline publishes a waiting card under. */
export const ATTENTION_PENDING_V1 = eventType(
  { product: "superpipeline", entity: "attention", verb: "pending" },
  1,
);

export type AttentionIntake =
  | { status: "accepted"; key: WaitKey; duplicate: boolean }
  | { status: "ignored"; reason: "board not opted in" | "board disabled" }
  | { status: "invalid" };

/** The wait a waiting card names. */
export const waitKeyOf = (d: WaitKey): WaitKey => ({
  boardId: d.boardId,
  cardId: d.cardId,
  waitId: d.waitId,
});

/** Keep a delivered waiting card for an opted-in board. `body` is the event's data, unchecked. */
export function intakeAttention(
  store: Pick<Store, "getBoard" | "recordAttentionDelivery">,
  body: unknown,
): AttentionIntake {
  if (!isAttentionPending(body)) return { status: "invalid" };
  const board = store.getBoard(body.boardId);
  if (board === null)
    return { status: "ignored", reason: "board not opted in" };
  if (!board.enabled) return { status: "ignored", reason: "board disabled" };
  const key = waitKeyOf(body);
  const inserted = store.recordAttentionDelivery(key, body);
  return { status: "accepted", key, duplicate: !inserted };
}
