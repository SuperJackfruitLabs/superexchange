/**
 * A gate's receipt: the line that says the board has a decision, and the outcome event a client
 * closes the card by. Built only by treaty (`gateOutcomeBody`, `gateOutcomeContent`), and sent by
 * both ways a gate stops being pending here:
 *
 * - a person's answer in chat (`gate-answer.ts`), once the board took it;
 * - a decision made anywhere else (on the web, in `supi`, by another path), found by the sweep
 *   (`gate-sweep.ts`) and settled with `settleGate`.
 *
 * One receipt per gate, whichever comes first: both claim the same outcome columns before
 * anything is sent, and both send under the same transaction ids (`gateTxnId`), so even a retry
 * is answered by the homeserver with the first send's event.
 *
 * Ported from the AgentPod hub's `settleGateOutcome` (`services/board-chat/gate-decision.ts`).
 */
import {
  GATE_OUTCOME_TYPE,
  gateOutcomeBody,
  gateOutcomeContent,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { AppserviceClient } from "../appservice/index.ts";
import type { GateEvent, Store } from "../store/index.ts";
import { gateTxnId } from "./gate-card.ts";
import type { RoomSender } from "./room-sender.ts";

/** How a gate was decided, as its receipt says it. */
export interface GateDecided {
  decision: string;
  /** The decider's label, never an id or an mxid; null when it is not known. */
  decidedBy: string | null;
  /** On a choice gate, the variant an approval chose. */
  chosen: { id: string; label: string } | null;
  /** A held approval's release time. */
  heldUntil?: string | null;
}

/** Send a gate's receipt into its room: the prose line, then the outcome event at its card. */
export async function sendGateReceipt(
  client: Pick<AppserviceClient, "sendEvent">,
  speaker: string,
  gate: Pick<
    GateEvent,
    "gateId" | "boardId" | "roomId" | "cardEventId" | "proseEventId"
  >,
  decided: GateDecided,
): Promise<void> {
  await client.sendEvent(
    speaker,
    gate.roomId,
    "m.room.message",
    gateTxnId(gate.gateId, "outcome.prose"),
    { msgtype: "m.text", body: gateOutcomeBody(decided) },
  );
  await client.sendEvent(
    speaker,
    gate.roomId,
    GATE_OUTCOME_TYPE,
    gateTxnId(gate.gateId, "outcome.card"),
    gateOutcomeContent({
      ...decided,
      gateId: gate.gateId,
      boardId: gate.boardId,
      // The card is what a client draws buttons from: the receipt points at it.
      gateEventId: gate.cardEventId ?? gate.proseEventId ?? "",
    }),
  );
}

/**
 * What settling a gate decided elsewhere came to:
 *
 * - `settled`: its receipt was claimed and sent (or claimed and could not be sent, logged);
 * - `withdrawn`: it was never posted, and now never will be;
 * - `already`: it already has a receipt, from an answer in chat or an earlier sweep;
 * - `refused`: its room may not be spoken in (`room-sender.ts`); nothing is claimed;
 * - `unknown`: no such gate was delivered here.
 */
export type SettleOutcome =
  | "settled"
  | "withdrawn"
  | "already"
  | "refused"
  | "unknown";

export interface SettleDeps {
  store: Pick<
    Store,
    | "gateEvent"
    | "gateDelivery"
    | "boardRoomByRoomId"
    | "settleGateEvent"
    | "settleGateDelivery"
  >;
  sender: Pick<RoomSender, "sendEvent" | "refusal">;
  speaker: string;
  log: (line: string) => void;
  describe: (error: unknown) => string;
}

/**
 * Settle a gate the board says was decided: post its receipt once if it is in a room, and make
 * sure it is never posted if it is not. Run only in board chat's queue, between answers.
 */
export async function settleGate(
  deps: SettleDeps,
  gateId: string,
  decided: GateDecided,
): Promise<SettleOutcome> {
  const { store } = deps;
  const delivery = store.gateDelivery(gateId);
  const gate = store.gateEvent(gateId);
  if (delivery === null && gate === null) return "unknown";
  // Decided: whatever happens to the receipt, the card is not posted after this.
  store.settleGateDelivery(gateId);
  if (gate === null || gate.postedAt === null) {
    if (gate !== null) {
      deps.log(
        `board-chat: gate ${JSON.stringify(gateId)} was decided on the board before its card was posted; it is not posted`,
      );
    }
    return "withdrawn";
  }
  const room = store.boardRoomByRoomId(gate.roomId);
  if (room === null || deps.sender.refusal(room) !== null) return "refused";
  // The one claim: none while any receipt is claimed, the answer path's included.
  if (!store.settleGateEvent(gateId, decided.decision)) return "already";
  try {
    await sendGateReceipt(deps.sender, deps.speaker, gate, decided);
  } catch (error) {
    // Claimed and not sent: the card stays in the room, the gate is decided on the board, and a
    // second receipt never follows. Logged so an operator can see it.
    deps.log(
      `board-chat: gate ${JSON.stringify(gateId)} was decided on the board, and its receipt could not be posted (${deps.describe(error)})`,
    );
  }
  return "settled";
}
