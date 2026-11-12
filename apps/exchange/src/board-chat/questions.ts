/**
 * Questions the event relay delivers: an agent blocked on a person's answer, or a SuperToolkit
 * approval request waiting on one (`elicitation.pending` v1). Checked with treaty's
 * `isElicitationPending`, the predicate the AgentPod hub uses, and kept only for a board an
 * operator has opted in and not disabled, as gates are (`gates.ts`).
 *
 * **An approval request goes only into a room of this service's own workspace** (the hub's
 * `approvalRequestAllowed`, charter: "Waiting cards and broker approvals reach chat" §3–4). Its
 * preview carries every argument the broker would send, so it is kept only when the board's
 * Organization, as the operator opted it in, is the workspace this service's own token is for
 * (its `org` claim). One decision for the relay and the sweep (`question-sweep.ts`), so the two
 * cannot come to disagree. A workspace that cannot be told (no token) keeps nothing: fail closed,
 * logged once per board until it changes.
 *
 * Recorded once per question id, so a redelivery is accepted without a second row.
 */
import { eventType } from "@superjackfruitlabs/treaty-cloudevents";
import {
  isApprovalRequest,
  isElicitationPending,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { Board, Store } from "../store/index.ts";
import { AccountsError, claimOf, type ServiceTokens } from "./accounts.ts";

/** The CloudEvents type SuperPipeline publishes a pending question under. */
export const ELICITATION_PENDING_V1 = eventType(
  { product: "superpipeline", entity: "elicitation", verb: "pending" },
  1,
);

/** May an approval request on this board be posted into its room? */
export type ApprovalRequestAllowed = (
  board: Pick<Board, "boardId" | "orgId">,
) => Promise<boolean>;

export type QuestionIntake =
  | {
      status: "accepted";
      boardId: string;
      elicitationId: string;
      duplicate: boolean;
    }
  | {
      status: "ignored";
      reason:
        | "board not opted in"
        | "board disabled"
        | "approval request not allowed";
    }
  | { status: "invalid" };

/**
 * Keep a delivered question for an opted-in board. `body` is the event's data, unchecked. An
 * approval request is kept only when `approvalRequestAllowed` says so; absent, never.
 */
export async function intakeQuestion(
  store: Pick<Store, "getBoard" | "recordQuestionDelivery">,
  body: unknown,
  approvalRequestAllowed?: ApprovalRequestAllowed,
): Promise<QuestionIntake> {
  if (!isElicitationPending(body)) return { status: "invalid" };
  const board = store.getBoard(body.boardId);
  if (board === null)
    return { status: "ignored", reason: "board not opted in" };
  if (!board.enabled) return { status: "ignored", reason: "board disabled" };
  if (
    isApprovalRequest(body) &&
    !(approvalRequestAllowed && (await approvalRequestAllowed(board)))
  ) {
    return { status: "ignored", reason: "approval request not allowed" };
  }
  const inserted = store.recordQuestionDelivery(
    body.elicitationId,
    body.boardId,
    body,
  );
  return {
    status: "accepted",
    boardId: body.boardId,
    elicitationId: body.elicitationId,
    duplicate: !inserted,
  };
}

/**
 * The approval-request rule over this service's own token for SuperPipeline: allowed when the
 * token's workspace (`org`) is the board's `orgId`. The token is the one the sweeps read with,
 * held by `createServiceTokens`; it is never logged.
 */
export function createApprovalScope(deps: {
  tokens: Pick<ServiceTokens, "get">;
  log: (line: string) => void;
}): ApprovalRequestAllowed {
  /** Boards whose refusal is logged, with why: logged again only when the reason changes. */
  const logged = new Map<string, string>();
  const say = (boardId: string, why: string) => {
    if (logged.get(boardId) === why) return;
    logged.set(boardId, why);
    deps.log(
      `board-chat: an approval request on ${boardId} is not posted: ${why}`,
    );
  };
  return async (board) => {
    let token: string;
    try {
      token = await deps.tokens.get();
    } catch (error) {
      say(
        board.boardId,
        `this service's workspace cannot be told (${error instanceof AccountsError ? error.message : "no token"})`,
      );
      return false;
    }
    const org = claimOf(token, "org");
    if (typeof org !== "string" || org === "" || org !== board.orgId) {
      say(board.boardId, "the board is not in this service's workspace");
      return false;
    }
    logged.delete(board.boardId);
    return true;
  };
}
