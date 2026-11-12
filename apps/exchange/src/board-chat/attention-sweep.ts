/**
 * The waiting-card sweep: asking each board which cards are waiting on a person, beneath the
 * relay.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-sweep.ts` (`sweepAttention`). For every
 * enabled board, one at a time, with this service's own token
 * (`GET /v1/boards/:boardId/attention/pending`):
 *
 * 1. **Waits that never arrived.** A listed waiting card with no delivery recorded here is taken in
 *    as if the relay had delivered it (`intakeAttention`) and posted; one delivered and not yet
 *    posted is offered again.
 * 2. **Waits that ended elsewhere.** ABSENCE of that wait from the board's list is the signal: a
 *    card this service holds (posted without a receipt, or delivered and never posted) whose wait
 *    the list no longer names is closed (`settleAttention`), settled elsewhere: one receipt naming
 *    nobody, or never posted. A card listed again under a new wait id is a new card, and its old
 *    one is closed. Only with a list the board answered: a board that cannot be read (401 or 403
 *    while SuperPipeline does not admit this service's token on that route, 404 outside its
 *    workspace, down) closes nothing, is logged, and the boards after it are still asked. Any entry
 *    naming a card and a wait keeps that wait open, readable or not.
 *
 * Runs on its own schedule and backoff (`sweeper.ts`).
 */
import { isAttentionPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store, WaitKey } from "../store/index.ts";
import { AccountsError } from "./accounts.ts";
import { intakeAttention, waitKeyOf } from "./attention.ts";
import { waitLabel } from "./attention-card.ts";
import type { BoardChat } from "./gate-card.ts";
import { describe as describeClientError } from "./rooms.ts";
import {
  SuperpipelineError,
  type SuperpipelineReads,
} from "./superpipeline.ts";
import { startSweeper, type Sweeper, type SweeperOptions } from "./sweeper.ts";

export interface AttentionSweepDeps {
  store: Pick<
    Store,
    | "listBoards"
    | "getBoard"
    | "attentionDelivery"
    | "recordAttentionDelivery"
    | "attentionEvent"
    | "postedAttentionAwaitingOutcome"
    | "unpostedAttention"
  >;
  board: Pick<SuperpipelineReads, "pendingAttention">;
  chat: Pick<BoardChat, "postAttention" | "settleAttention">;
  log: (line: string) => void;
}

export interface AttentionSweepResult {
  boards: number;
  failedBoards: number;
  /** Waiting cards the boards listed. */
  checked: number;
  /** Waiting cards found only by the sweep. */
  projected: number;
  /** Cards closed in their room, or withdrawn before they were posted. */
  settled: number;
  /** Entries the board listed in a shape that is not an attention.pending of that board. */
  unreadable: number;
  /** Cards that could not be posted or closed this pass. */
  failedCards: number;
}

/** One wait's identity on a board, as the sweep compares them. */
const waitId = (k: Pick<WaitKey, "cardId" | "waitId">) =>
  JSON.stringify([k.cardId, k.waitId]);

/** One pass over every enabled board. Never throws for one board or one card. */
export async function sweepAttention(
  deps: AttentionSweepDeps,
): Promise<AttentionSweepResult> {
  const { store, log } = deps;
  const result: AttentionSweepResult = {
    boards: 0,
    failedBoards: 0,
    checked: 0,
    projected: 0,
    settled: 0,
    unreadable: 0,
    failedCards: 0,
  };

  for (const board of store.listBoards()) {
    if (!board.enabled) continue;
    result.boards++;
    const boardId = board.boardId;

    let listed: unknown[];
    try {
      listed = await deps.board.pendingAttention(boardId);
    } catch (error) {
      result.failedBoards++;
      log(
        `board-chat: the sweep could not read the waiting cards of ${boardId} (${describe(error)})`,
      );
      continue;
    }

    const stillWaiting = new Set<string>();
    for (const entry of listed) {
      // Named, it is not over: absence closes a card, and an entry this build cannot read is not
      // absence.
      const named = entry as { cardId?: unknown; waitId?: unknown } | null;
      if (typeof named?.cardId === "string" && typeof named.waitId === "string")
        stillWaiting.add(
          waitId({ cardId: named.cardId, waitId: named.waitId }),
        );
      if (!isAttentionPending(entry) || entry.boardId !== boardId) {
        result.unreadable++;
        continue;
      }
      result.checked++;
      const key = waitKeyOf(entry);
      try {
        if (store.attentionDelivery(key) === null) {
          const intake = intakeAttention(store, entry);
          if (intake.status !== "accepted" || intake.duplicate) continue;
          result.projected++;
          await deps.chat.postAttention(key);
        } else if (!store.attentionEvent(key)?.postedAt) {
          await deps.chat.postAttention(key);
        }
      } catch (error) {
        result.failedCards++;
        log(
          `board-chat: the sweep could not post ${waitLabel(key)} on ${boardId} (${describe(error)})`,
        );
      }
    }

    const held = new Map<string, WaitKey>();
    for (const k of [
      ...store.postedAttentionAwaitingOutcome(boardId),
      ...store.unpostedAttention(boardId),
    ])
      held.set(waitId(k), waitKeyOf(k));
    for (const [id, key] of held) {
      if (stillWaiting.has(id)) continue;
      try {
        const outcome = await deps.chat.settleAttention(key);
        if (outcome === "settled" || outcome === "withdrawn") result.settled++;
      } catch (error) {
        result.failedCards++;
        log(
          `board-chat: the sweep could not close ${waitLabel(key)} on ${boardId} (${describe(error)})`,
        );
      }
    }
  }

  if (
    result.projected +
      result.settled +
      result.failedBoards +
      result.unreadable +
      result.failedCards >
    0
  ) {
    log(
      `board-chat: waiting-card sweep of ${result.boards} board(s): ${result.checked} waiting, ${result.projected} found only by the sweep, ${result.settled} closed, ${result.failedBoards} board(s) and ${result.failedCards} card(s) unreadable, ${result.unreadable} entr(ies) not a waiting card`,
    );
  }
  return result;
}

export type AttentionSweeper = Sweeper;

/** Sweep now, then every interval (backing off while every board fails), until stopped. */
export function startAttentionSweep(
  deps: AttentionSweepDeps,
  options: SweeperOptions,
): AttentionSweeper {
  return startSweeper(
    () => sweepAttention(deps),
    (error) =>
      deps.log(
        `board-chat: the waiting-card sweep failed (${describe(error)})`,
      ),
    options,
  );
}

/** An error as a log may carry it: status and code only, never a URL, a token or a body. */
function describe(error: unknown): string {
  if (error instanceof SuperpipelineError || error instanceof AccountsError)
    return error.message;
  return describeClientError(error);
}
