/**
 * Gates the event relay delivers. A `gate.pending` (v1) is checked with treaty's `isGatePending`,
 * the same predicate the AgentPod hub uses, and kept only for a board an operator has opted in
 * and not disabled. Every other board's gate is ignored: while both projectors run, each board
 * has exactly one of them projecting its gates, and a board not opted in here belongs to the
 * other.
 *
 * Recorded once per gate id, so a redelivery is accepted without a second row. Nothing is posted
 * to Matrix yet; board rooms and the cards in them arrive in a later step.
 */
import { eventType } from "@superjackfruitlabs/treaty-cloudevents";
import { isGatePending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store } from "../store/index.ts";

/** The CloudEvents type SuperPipeline publishes a pending gate under. */
export const GATE_PENDING_V1 = eventType(
  { product: "superpipeline", entity: "gate", verb: "pending" },
  1,
);

export type GateIntake =
  | { status: "accepted"; boardId: string; gateId: string; duplicate: boolean }
  | { status: "ignored"; reason: "board not opted in" | "board disabled" }
  | { status: "invalid" };

/** Keep a delivered gate for an opted-in board. `body` is the event's data, unchecked. */
export function intakeGate(
  store: Pick<Store, "getBoard" | "recordGateDelivery">,
  body: unknown,
): GateIntake {
  if (!isGatePending(body)) return { status: "invalid" };
  const board = store.getBoard(body.boardId);
  if (board === null)
    return { status: "ignored", reason: "board not opted in" };
  if (!board.enabled) return { status: "ignored", reason: "board disabled" };
  const inserted = store.recordGateDelivery(body.gateId, body.boardId, body);
  return {
    status: "accepted",
    boardId: body.boardId,
    gateId: body.gateId,
    duplicate: !inserted,
  };
}
