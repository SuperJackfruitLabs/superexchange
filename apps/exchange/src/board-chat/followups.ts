/**
 * Delivery follow-ups the event relay delivers: a post approved for manual delivery that still owes
 * the board its live link (`delivery.pending` v1, charter: "The decision envelope covers questions
 * and follow-ups" §3). Checked with treaty's `isDeliveryPending`, the predicate the AgentPod hub
 * uses, and kept only for a board an operator has opted in and not disabled, as gates are
 * (`gates.ts`).
 *
 * Recorded once per gate id (a follow-up belongs to the gate it follows), so a redelivery is
 * accepted without a second row.
 */
import { eventType } from "@superjackfruitlabs/treaty-cloudevents";
import { isDeliveryPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store } from "../store/index.ts";

/** The CloudEvents type SuperPipeline publishes a pending follow-up under. */
export const DELIVERY_PENDING_V1 = eventType(
  { product: "superpipeline", entity: "delivery", verb: "pending" },
  1,
);

export type FollowupIntake =
  | { status: "accepted"; boardId: string; gateId: string; duplicate: boolean }
  | { status: "ignored"; reason: "board not opted in" | "board disabled" }
  | { status: "invalid" };

/** Keep a delivered follow-up for an opted-in board. `body` is the event's data, unchecked. */
export function intakeFollowup(
  store: Pick<Store, "getBoard" | "recordFollowupDelivery">,
  body: unknown,
): FollowupIntake {
  if (!isDeliveryPending(body)) return { status: "invalid" };
  const board = store.getBoard(body.boardId);
  if (board === null)
    return { status: "ignored", reason: "board not opted in" };
  if (!board.enabled) return { status: "ignored", reason: "board disabled" };
  const inserted = store.recordFollowupDelivery(
    body.gateId,
    body.boardId,
    body,
  );
  return {
    status: "accepted",
    boardId: body.boardId,
    gateId: body.gateId,
    duplicate: !inserted,
  };
}
