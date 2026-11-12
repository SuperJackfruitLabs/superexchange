/**
 * The gate sweep: asking each board what it is still waiting on, beneath the event relay.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-sweep.ts` (`sweepGates`,
 * `startGateSweeper`), its gate half. For every enabled board, one at a time, with this service's
 * own token on `gates:read` (`superpipeline.ts`):
 *
 * 1. **Gates that never arrived.** A pending gate with no delivery recorded here (the relay
 *    missed one, or gave up) is recorded as if it had been delivered and posted like any other;
 *    a pending gate delivered and not yet posted is offered again (its post holds for a join,
 *    fails closed on encryption, and is idempotent on its claim, so offering twice is harmless).
 * 2. **Gates decided elsewhere.** A gate this service holds (posted without a receipt, or
 *    delivered and not yet posted) that the board no longer lists as pending is read. Only one
 *    the board reads as `resolved`, with a decision, is settled (`gate-receipt.ts`): its receipt,
 *    the same treaty content the answer path posts, once; or, never posted, it never is. Absence
 *    from the list is not a decision: a gate the board cannot say how it was decided is left as
 *    it is, and a board whose list could not be read settles nothing.
 *
 * A board that cannot be read (404 for a board not in this service's workspace, 403 without
 * `gates:read`, a refused or missing token, a board down) is logged and stepped over: the boards
 * behind it are still asked. A pass logs counts, and only when something happened.
 *
 * Every `SUPEREXCHANGE_SWEEP_SECONDS`, and once at boot. A pass in which every board failed waits
 * twice as long before the next, up to `SWEEP_MAX_BACKOFF` times the interval; a pass that read
 * any board goes back to the interval. Passes never overlap.
 *
 * Reminders and escalations are not swept here: the relay carries only `gate.pending` today.
 */
import { isGatePending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store } from "../store/index.ts";
import { AccountsError } from "./accounts.ts";
import type { BoardChat } from "./gate-card.ts";
import { intakeGate } from "./gates.ts";
import { describe as describeClientError } from "./rooms.ts";
import {
  SuperpipelineError,
  type SuperpipelineReads,
} from "./superpipeline.ts";

/** The most the interval is multiplied by while every board keeps failing. */
export const SWEEP_MAX_BACKOFF = 8;

export interface GateSweepDeps {
  store: Pick<
    Store,
    | "listBoards"
    | "getBoard"
    | "gateDelivery"
    | "recordGateDelivery"
    | "gateEvent"
    | "postedGatesAwaitingOutcome"
    | "unpostedGates"
  >;
  board: SuperpipelineReads;
  chat: Pick<BoardChat, "post" | "settle">;
  /** How a receipt names the principal who decided; null when it cannot. */
  labelFor(principalId: string): Promise<string | null>;
  log: (line: string) => void;
}

export interface GateSweepResult {
  /** Enabled boards asked. */
  boards: number;
  /** Boards whose pending gates could not be read. */
  failedBoards: number;
  /** Pending gates the boards listed. */
  checked: number;
  /** Pending gates found only by the sweep: recorded here now, as if delivered. */
  projected: number;
  /** Gates decided elsewhere whose receipt this pass posted, or which will now never be posted. */
  settled: number;
  /** Entries the board listed in a shape that is not a gate.pending of that board. */
  unreadable: number;
  /** Gates whose state the board would not give. */
  failedGates: number;
}

/** One pass over every enabled board. Never throws for one board or one gate. */
export async function sweepGates(
  deps: GateSweepDeps,
): Promise<GateSweepResult> {
  const { store, log } = deps;
  const result: GateSweepResult = {
    boards: 0,
    failedBoards: 0,
    checked: 0,
    projected: 0,
    settled: 0,
    unreadable: 0,
    failedGates: 0,
  };

  for (const board of store.listBoards()) {
    if (!board.enabled) continue;
    result.boards++;
    const boardId = board.boardId;

    let listed: unknown[];
    try {
      listed = await deps.board.pendingGates(boardId);
    } catch (error) {
      result.failedBoards++;
      log(
        `board-chat: the sweep could not read the pending gates of ${boardId} (${describe(error)})`,
      );
      continue;
    }

    const stillPending = new Set<string>();
    for (const entry of listed) {
      // A gate of another board in this board's list is not this board's to post.
      if (!isGatePending(entry) || entry.boardId !== boardId) {
        result.unreadable++;
        continue;
      }
      result.checked++;
      stillPending.add(entry.gateId);
      try {
        if (store.gateDelivery(entry.gateId) === null) {
          const intake = intakeGate(store, entry);
          if (intake.status !== "accepted" || intake.duplicate) continue;
          result.projected++;
          await deps.chat.post(entry.gateId);
        } else if (!store.gateEvent(entry.gateId)?.postedAt) {
          await deps.chat.post(entry.gateId);
        }
      } catch (error) {
        result.failedGates++;
        log(
          `board-chat: the sweep could not post gate ${JSON.stringify(entry.gateId)} on ${boardId} (${describe(error)})`,
        );
      }
    }

    // Only with a list the board answered: absent from it then means no longer pending.
    const held = new Set<string>([
      ...store.postedGatesAwaitingOutcome(boardId).map((g) => g.gateId),
      ...store.unpostedGates(boardId).map((g) => g.gateId),
    ]);
    for (const gateId of held) {
      if (stillPending.has(gateId)) continue;
      try {
        const gate = await deps.board.gate(boardId, gateId);
        // Absence is not a decision: a gate the board cannot say how was decided is left alone.
        if (gate.status !== "resolved" || gate.decision === null) continue;
        // A held approval pulled back went back for rework: it reads as changes requested, by
        // whoever pulled it back, never as an approval that will act (the hub's rule).
        const pulledBack = gate.pulledBackBy !== null;
        const decider = pulledBack ? gate.pulledBackBy : gate.decidedBy;
        const outcome = await deps.chat.settle(gateId, {
          decision: pulledBack ? "request_changes" : gate.decision,
          decidedBy: decider ? await label(deps, decider) : null,
          chosen: pulledBack ? null : gate.chosen,
          heldUntil: pulledBack ? null : gate.heldUntil,
        });
        if (outcome === "settled" || outcome === "withdrawn") result.settled++;
      } catch (error) {
        result.failedGates++;
        log(
          `board-chat: the sweep could not settle gate ${JSON.stringify(gateId)} on ${boardId} (${describe(error)})`,
        );
      }
    }
  }

  if (
    result.projected +
      result.settled +
      result.failedBoards +
      result.unreadable +
      result.failedGates >
    0
  ) {
    log(
      `board-chat: sweep of ${result.boards} board(s): ${result.checked} pending, ${result.projected} found only by the sweep, ${result.settled} settled from the board, ${result.failedBoards} board(s) and ${result.failedGates} gate(s) unreadable, ${result.unreadable} entr(ies) not a gate`,
    );
  }
  return result;
}

/** A decider's label for the receipt; null when the plane cannot say, never their id. */
async function label(
  deps: GateSweepDeps,
  principalId: string,
): Promise<string | null> {
  try {
    return await deps.labelFor(principalId);
  } catch {
    return null;
  }
}

export interface GateSweeper {
  stop(): void;
}

export interface SweeperOptions {
  intervalMs: number;
  /** Test seams: how the next pass is scheduled and cancelled. */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Sweep now, then every interval (backing off while every board fails), until stopped. */
export function startGateSweep(
  deps: GateSweepDeps,
  options: SweeperOptions,
): GateSweeper {
  const schedule =
    options.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let failing = 0;
  let stopped = false;
  let handle: unknown = null;

  async function pass(): Promise<void> {
    try {
      const r = await sweepGates(deps);
      failing = r.boards > 0 && r.failedBoards === r.boards ? failing + 1 : 0;
    } catch (error) {
      failing++;
      deps.log(`board-chat: the sweep failed (${describe(error)})`);
    }
    if (stopped) return;
    const factor = Math.min(2 ** failing, SWEEP_MAX_BACKOFF);
    handle = schedule(() => void pass(), options.intervalMs * factor);
  }

  void pass();
  return {
    stop() {
      stopped = true;
      if (handle !== null) cancel(handle);
    },
  };
}

/** An error as a log may carry it: status and code only, never a URL, a token or a body. */
function describe(error: unknown): string {
  if (error instanceof SuperpipelineError || error instanceof AccountsError)
    return error.message;
  return describeClientError(error);
}
