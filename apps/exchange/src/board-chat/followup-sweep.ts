/**
 * The follow-up sweep: asking each board which delivery follow-ups it is still owed, beneath the
 * relay.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-sweep.ts` (`sweepDeliveries`). For every
 * enabled board, one at a time, with this service's own token
 * (`GET /v1/boards/:boardId/deliveries/pending`):
 *
 * 1. **Follow-ups that never arrived.** A listed follow-up with no delivery recorded here is taken
 *    in as if the relay had delivered it (`intakeFollowup`) and posted; one delivered and not yet
 *    posted is offered again (its post holds for a join, fails closed on encryption, and is
 *    idempotent on its claim).
 * 2. **Follow-ups the board no longer owes** (the link recorded on the web, the mode switched, the
 *    approval expired). ABSENCE from the board's list is the signal: a follow-up this service holds
 *    (posted without a receipt, or delivered and never posted) that the list no longer names is
 *    settled (`settleFollowup`): one receipt naming nobody, or never posted. Only with a list the
 *    board answered: a board that cannot be read (401 or 403 while SuperPipeline does not admit
 *    this service's token on that route, 404 outside its workspace, down) settles nothing, is
 *    logged, and the boards after it are still asked. Any entry naming a gate id keeps that
 *    follow-up open, readable or not.
 *
 * Runs on its own schedule and backoff (`sweeper.ts`), so a board that refuses this read never
 * slows the gate or question sweeps.
 */
import { isDeliveryPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store } from "../store/index.ts";
import { AccountsError } from "./accounts.ts";
import type { BoardChat } from "./gate-card.ts";
import { intakeFollowup } from "./followups.ts";
import { describe as describeClientError } from "./rooms.ts";
import {
  SuperpipelineError,
  type SuperpipelineReads,
} from "./superpipeline.ts";
import { startSweeper, type Sweeper, type SweeperOptions } from "./sweeper.ts";

export interface FollowupSweepDeps {
  store: Pick<
    Store,
    | "listBoards"
    | "getBoard"
    | "followupDelivery"
    | "recordFollowupDelivery"
    | "followupEvent"
    | "postedFollowupsAwaitingOutcome"
    | "unpostedFollowups"
  >;
  board: Pick<SuperpipelineReads, "pendingFollowups">;
  chat: Pick<BoardChat, "postFollowup" | "settleFollowup">;
  log: (line: string) => void;
}

export interface FollowupSweepResult {
  boards: number;
  failedBoards: number;
  /** Pending follow-ups the boards listed. */
  checked: number;
  /** Pending follow-ups found only by the sweep. */
  projected: number;
  /** Follow-ups settled in their room, or withdrawn before they were posted. */
  settled: number;
  /** Entries the board listed in a shape that is not a delivery.pending of that board. */
  unreadable: number;
  /** Follow-ups that could not be posted or settled this pass. */
  failedFollowups: number;
}

/** One pass over every enabled board. Never throws for one board or one follow-up. */
export async function sweepFollowups(
  deps: FollowupSweepDeps,
): Promise<FollowupSweepResult> {
  const { store, log } = deps;
  const result: FollowupSweepResult = {
    boards: 0,
    failedBoards: 0,
    checked: 0,
    projected: 0,
    settled: 0,
    unreadable: 0,
    failedFollowups: 0,
  };

  for (const board of store.listBoards()) {
    if (!board.enabled) continue;
    result.boards++;
    const boardId = board.boardId;

    let listed: unknown[];
    try {
      listed = await deps.board.pendingFollowups(boardId);
    } catch (error) {
      result.failedBoards++;
      log(
        `board-chat: the sweep could not read the pending follow-ups of ${boardId} (${describe(error)})`,
      );
      continue;
    }

    const stillOwed = new Set<string>();
    for (const entry of listed) {
      // Named, it is not settled: absence settles a follow-up, and an entry this build cannot read
      // is not absence.
      const named = (entry as { gateId?: unknown } | null)?.gateId;
      if (typeof named === "string") stillOwed.add(named);
      if (!isDeliveryPending(entry) || entry.boardId !== boardId) {
        result.unreadable++;
        continue;
      }
      result.checked++;
      try {
        if (store.followupDelivery(entry.gateId) === null) {
          const intake = intakeFollowup(store, entry);
          if (intake.status !== "accepted" || intake.duplicate) continue;
          result.projected++;
          await deps.chat.postFollowup(entry.gateId);
        } else if (!store.followupEvent(entry.gateId)?.postedAt) {
          await deps.chat.postFollowup(entry.gateId);
        }
      } catch (error) {
        result.failedFollowups++;
        log(
          `board-chat: the sweep could not post follow-up ${JSON.stringify(entry.gateId)} on ${boardId} (${describe(error)})`,
        );
      }
    }

    const held = new Set<string>([
      ...store.postedFollowupsAwaitingOutcome(boardId).map((f) => f.gateId),
      ...store.unpostedFollowups(boardId).map((f) => f.gateId),
    ]);
    for (const gateId of held) {
      if (stillOwed.has(gateId)) continue;
      try {
        const outcome = await deps.chat.settleFollowup(gateId);
        if (outcome === "settled" || outcome === "withdrawn") result.settled++;
      } catch (error) {
        result.failedFollowups++;
        log(
          `board-chat: the sweep could not settle follow-up ${JSON.stringify(gateId)} on ${boardId} (${describe(error)})`,
        );
      }
    }
  }

  if (
    result.projected +
      result.settled +
      result.failedBoards +
      result.unreadable +
      result.failedFollowups >
    0
  ) {
    log(
      `board-chat: follow-up sweep of ${result.boards} board(s): ${result.checked} pending, ${result.projected} found only by the sweep, ${result.settled} settled, ${result.failedBoards} board(s) and ${result.failedFollowups} follow-up(s) unreadable, ${result.unreadable} entr(ies) not a follow-up`,
    );
  }
  return result;
}

export type FollowupSweeper = Sweeper;

/** Sweep now, then every interval (backing off while every board fails), until stopped. */
export function startFollowupSweep(
  deps: FollowupSweepDeps,
  options: SweeperOptions,
): FollowupSweeper {
  return startSweeper(
    () => sweepFollowups(deps),
    (error) =>
      deps.log(`board-chat: the follow-up sweep failed (${describe(error)})`),
    options,
  );
}

/** An error as a log may carry it: status and code only, never a URL, a token or a body. */
function describe(error: unknown): string {
  if (error instanceof SuperpipelineError || error instanceof AccountsError)
    return error.message;
  return describeClientError(error);
}
