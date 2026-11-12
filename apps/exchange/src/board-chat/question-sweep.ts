/**
 * The question sweep: asking each board which questions it still waits on, beneath the relay.
 *
 * Ported from the AgentPod hub's `services/board-chat/elicitation-sweep.ts` (`sweepElicitations`).
 * For every enabled board, one at a time, with this service's own token on
 * `approval-requests:relay` (`GET /v1/boards/:boardId/elicitations/pending`, broker approval
 * requests included):
 *
 * 1. **Questions that never arrived.** A pending question with no delivery recorded here is taken
 *    in as if the relay had delivered it (`intakeQuestion`, the approval-request rule included)
 *    and posted; one delivered and not yet posted is offered again (its post holds for a join,
 *    fails closed on encryption, and is idempotent on its claim).
 * 2. **Questions that are over.** Unlike a gate, a question is also retired by the agent's next
 *    question, so ABSENCE from the board's list is the signal: a question this service holds
 *    (posted without a receipt, or delivered and never posted) that the list no longer names is
 *    closed (`settleQuestion`): one line in the room, or never posted. Only with a list the board
 *    answered: a board that cannot be read (403 without `approval-requests:relay`, 404 outside this
 *    service's workspace, down) closes nothing, is logged, and the boards after it are still asked.
 *    Any entry naming a question id keeps that question open, readable or not.
 */
import { isElicitationPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { Store } from "../store/index.ts";
import { AccountsError } from "./accounts.ts";
import type { BoardChat } from "./gate-card.ts";
import { intakeQuestion, type ApprovalRequestAllowed } from "./questions.ts";
import { describe as describeClientError } from "./rooms.ts";
import {
  SuperpipelineError,
  type SuperpipelineReads,
} from "./superpipeline.ts";
import { startSweeper, type Sweeper, type SweeperOptions } from "./sweeper.ts";

export interface QuestionSweepDeps {
  store: Pick<
    Store,
    | "listBoards"
    | "getBoard"
    | "questionDelivery"
    | "recordQuestionDelivery"
    | "questionEvent"
    | "postedQuestionsAwaitingOutcome"
    | "unpostedQuestions"
  >;
  board: Pick<SuperpipelineReads, "pendingQuestions">;
  chat: Pick<BoardChat, "postQuestion" | "settleQuestion">;
  approvalRequestAllowed: ApprovalRequestAllowed;
  log: (line: string) => void;
}

export interface QuestionSweepResult {
  boards: number;
  failedBoards: number;
  /** Pending questions the boards listed. */
  checked: number;
  /** Pending questions found only by the sweep. */
  projected: number;
  /** Questions closed in their room, or withdrawn before they were posted. */
  settled: number;
  /** Entries the board listed in a shape that is not an elicitation.pending of that board. */
  unreadable: number;
  /** Questions that could not be posted or closed this pass. */
  failedQuestions: number;
}

/** One pass over every enabled board. Never throws for one board or one question. */
export async function sweepQuestions(
  deps: QuestionSweepDeps,
): Promise<QuestionSweepResult> {
  const { store, log } = deps;
  const result: QuestionSweepResult = {
    boards: 0,
    failedBoards: 0,
    checked: 0,
    projected: 0,
    settled: 0,
    unreadable: 0,
    failedQuestions: 0,
  };

  for (const board of store.listBoards()) {
    if (!board.enabled) continue;
    result.boards++;
    const boardId = board.boardId;

    let listed: unknown[];
    try {
      listed = await deps.board.pendingQuestions(boardId);
    } catch (error) {
      result.failedBoards++;
      log(
        `board-chat: the sweep could not read the pending questions of ${boardId} (${describe(error)})`,
      );
      continue;
    }

    const stillPending = new Set<string>();
    for (const entry of listed) {
      // Named, it is not over: absence closes a question, and an entry this build cannot read is
      // not absence.
      const named = (entry as { elicitationId?: unknown } | null)
        ?.elicitationId;
      if (typeof named === "string") stillPending.add(named);
      if (!isElicitationPending(entry) || entry.boardId !== boardId) {
        result.unreadable++;
        continue;
      }
      result.checked++;
      try {
        if (store.questionDelivery(entry.elicitationId) === null) {
          const intake = await intakeQuestion(
            store,
            entry,
            deps.approvalRequestAllowed,
          );
          if (intake.status !== "accepted" || intake.duplicate) continue;
          result.projected++;
          await deps.chat.postQuestion(entry.elicitationId);
        } else if (!store.questionEvent(entry.elicitationId)?.postedAt) {
          await deps.chat.postQuestion(entry.elicitationId);
        }
      } catch (error) {
        result.failedQuestions++;
        log(
          `board-chat: the sweep could not post question ${JSON.stringify(entry.elicitationId)} on ${boardId} (${describe(error)})`,
        );
      }
    }

    const held = new Set<string>([
      ...store
        .postedQuestionsAwaitingOutcome(boardId)
        .map((q) => q.elicitationId),
      ...store.unpostedQuestions(boardId).map((q) => q.elicitationId),
    ]);
    for (const elicitationId of held) {
      if (stillPending.has(elicitationId)) continue;
      try {
        const outcome = await deps.chat.settleQuestion(elicitationId);
        if (outcome === "settled" || outcome === "withdrawn") result.settled++;
      } catch (error) {
        result.failedQuestions++;
        log(
          `board-chat: the sweep could not close question ${JSON.stringify(elicitationId)} on ${boardId} (${describe(error)})`,
        );
      }
    }
  }

  if (
    result.projected +
      result.settled +
      result.failedBoards +
      result.unreadable +
      result.failedQuestions >
    0
  ) {
    log(
      `board-chat: question sweep of ${result.boards} board(s): ${result.checked} pending, ${result.projected} found only by the sweep, ${result.settled} closed, ${result.failedBoards} board(s) and ${result.failedQuestions} question(s) unreadable, ${result.unreadable} entr(ies) not a question`,
    );
  }
  return result;
}

export type QuestionSweeper = Sweeper;

/** Sweep now, then every interval (backing off while every board fails), until stopped. */
export function startQuestionSweep(
  deps: QuestionSweepDeps,
  options: SweeperOptions,
): QuestionSweeper {
  return startSweeper(
    () => sweepQuestions(deps),
    (error) =>
      deps.log(`board-chat: the question sweep failed (${describe(error)})`),
    options,
  );
}

/** An error as a log may carry it: status and code only, never a URL, a token or a body. */
function describe(error: unknown): string {
  if (error instanceof SuperpipelineError || error instanceof AccountsError)
    return error.message;
  return describeClientError(error);
}
