/**
 * Board work in chat: gates, questions, follow-ups and waiting cards projected into board rooms,
 * the board's notices about them said there, and the answers carried back to the board. Built on the appservice transport, the store and
 * treaty's board-room contract (`@superjackfruitlabs/treaty-matrix-events`).
 *
 * - `boards.ts`: what an opted-in board is, and the checks on its settings.
 * - `gates.ts`: the relay's `gate.pending` deliveries, kept for opted-in boards.
 * - `rooms.ts`: each board's room, made once, its people invited, and who has joined it.
 * - `room-sender.ts`: speaking in a board room, encrypted when the room is, never plaintext into
 *   an encrypted room and nothing into a plaintext one while plaintext rooms are off.
 * - `gate-card.ts`: posting a kept gate into its room once a person has joined, exactly once;
 *   and the way in, encrypted events decrypted (or parked until their key arrives) and read.
 * - `gate-answer.ts`: a person's answer to a gate card, resolved at SuperPipeline as that person,
 *   and its receipt, once.
 * - `gate-receipt.ts`: a gate's receipt, once, whether it was answered in chat or decided
 *   elsewhere.
 * - `gate-sweep.ts`: asking each board what it still waits on: gates the relay missed are posted,
 *   gates decided elsewhere settled.
 * - `questions.ts`: the relay's `elicitation.pending` deliveries (an agent's question, or a broker
 *   approval request), kept for opted-in boards; an approval request only for a board in this
 *   service's own workspace.
 * - `question-card.ts`: posting a kept question into its room once a person has joined, exactly
 *   once; and closing it when the board no longer waits on it.
 * - `question-answer.ts`: a person's answer to a question (question.answer.v2, or a typed reply),
 *   carried to SuperPipeline as that person, and its receipt, once.
 * - `question-sweep.ts`: asking each board which questions it still waits on.
 * - `followups.ts`, `attention.ts`: the relay's `delivery.pending` (a manual delivery's follow-up)
 *   and `attention.pending` (a card waiting on a person), kept for opted-in boards.
 * - `card-post.ts`: posting one single-event card, held, claimed and sent once.
 * - `followup-card.ts`, `attention-card.ts`: posting a follow-up or a waiting card, and its one
 *   receipt, whether answered in chat or settled on the board.
 * - `card-answer.ts`: what every answer to such a card shares (a person, in a board room here).
 * - `followup-answer.ts`, `attention-answer.ts`: delivery.answer.v2 and attention.answer.v2,
 *   carried to SuperPipeline as the person who answered.
 * - `followup-sweep.ts`, `attention-sweep.ts`: asking each board which follow-ups it is still
 *   owed and which cards still wait.
 * - `notices.ts`: the relay's board-room notices (reminders, escalations, quorum progress, held
 *   approvals released or pulled back, checks failed or overridden), kept for opted-in boards when
 *   the card they concern was posted here.
 * - `notice-post.ts`: posting a notice once, in reply to its card; an escalation's invites and its
 *   checks.waiting card.
 * - `escalation-repost.ts`: an escalation's card moved below, and its notice posted again, for the
 *   admin it invited once they join.
 * - `pull-back.ts`: gate.pull_back.v2 and check.override.v2, carried to SuperPipeline as the person.
 * - `sweeper.ts`: running a sweep on its interval, backing off while every board fails.
 * - `accounts.ts`: the organization plane: who a sender is, the assertion that carries them, and
 *   this service's own token for reading boards.
 * - `superpipeline.ts`: resolving a gate, answering a question, a follow-up or a waiting card at
 *   SuperPipeline with that assertion, and reading a board's pending work with that token.
 *
 * Ported from the AgentPod hub's `services/board-chat`. Board rooms are end-to-end encrypted with
 * the speaker's own keys (`appservice/crypto.ts`); `SUPEREXCHANGE_PLAINTEXT_ROOMS`, staging only,
 * makes new ones in plaintext instead.
 */
export {
  BOARD_ID,
  MAX_INVITEES,
  isBoardId,
  isMatrixUserId,
  parseBoardSettings,
  type BoardSettings,
} from "./boards.ts";
export { GATE_PENDING_V1, intakeGate, type GateIntake } from "./gates.ts";
export {
  PENDING_MAX,
  PENDING_TTL_MS,
  createBoardChat,
  gateOffer,
  gateTxnId,
  type BoardChat,
  type BoardChatDeps,
  type NoticeChatDeps,
  type PostOutcome,
} from "./gate-card.ts";
export {
  ALREADY_DECIDED_TEXT,
  IDENTITY_UNAVAILABLE_TEXT,
  createGateAnswers,
  type AnswerOutcome,
  type GateAnswers,
  type GateAnswersDeps,
} from "./gate-answer.ts";
export {
  sendGateReceipt,
  settleGate,
  type GateDecided,
  type SettleOutcome,
} from "./gate-receipt.ts";
export {
  ELICITATION_PENDING_V1,
  createApprovalScope,
  intakeQuestion,
  type ApprovalRequestAllowed,
  type QuestionIntake,
} from "./questions.ts";
export {
  QUESTION_CLOSED_TEXT,
  questionOffer,
  questionTxnId,
  type QuestionPostOutcome,
  type QuestionSettleOutcome,
} from "./question-card.ts";
export {
  ALREADY_SETTLED_TEXT,
  APPROVAL_UNBOUND_TEXT,
  TYPED_APPROVAL_REFUSED_TEXT,
  createQuestionAnswers,
  matchReply,
  unmatchedText,
  type QuestionAnswerOutcome,
  type QuestionAnswers,
  type QuestionAnswersDeps,
} from "./question-answer.ts";
export {
  startQuestionSweep,
  sweepQuestions,
  type QuestionSweepDeps,
  type QuestionSweepResult,
  type QuestionSweeper,
} from "./question-sweep.ts";
export {
  DELIVERY_PENDING_V1,
  intakeFollowup,
  type FollowupIntake,
} from "./followups.ts";
export {
  ATTENTION_PENDING_V1,
  intakeAttention,
  waitKeyOf,
  type AttentionIntake,
} from "./attention.ts";
export {
  followupOffer,
  followupReceiptBody,
  followupTxnId,
  type FollowupPostOutcome,
  type FollowupSettleOutcome,
} from "./followup-card.ts";
export {
  attentionOffer,
  attentionReceiptBody,
  attentionTxnId,
  type AttentionPostOutcome,
  type AttentionSettleOutcome,
} from "./attention-card.ts";
export {
  FOLLOWUP_REFUSAL_TEXT,
  createFollowupAnswers,
  type FollowupAnswerOutcome,
  type FollowupAnswers,
  type FollowupAnswersDeps,
} from "./followup-answer.ts";
export {
  WAIT_CHANGED_TEXT,
  createAttentionAnswers,
  type AttentionAnswerOutcome,
  type AttentionAnswers,
  type AttentionAnswersDeps,
} from "./attention-answer.ts";
export {
  startFollowupSweep,
  sweepFollowups,
  type FollowupSweepDeps,
  type FollowupSweepResult,
} from "./followup-sweep.ts";
export {
  startAttentionSweep,
  sweepAttention,
  type AttentionSweepDeps,
  type AttentionSweepResult,
} from "./attention-sweep.ts";
export {
  CHECK_FAILED_V1,
  CHECK_OVERRIDDEN_V1,
  DECISION_ESCALATED_V1,
  DECISION_PULLED_BACK_V1,
  DECISION_RELEASED_V1,
  DECISION_REMINDED_V1,
  GATE_APPROVAL_RECORDED_V1,
  NOTICE_TYPES,
  decisionCard,
  intakeNotice,
  noticeInputOf,
  noticeTypeOf,
  type NoticeIntake,
} from "./notices.ts";
export {
  checksWaitingTxnId,
  createEscalationRecipients,
  noticeTxnId,
  readWaitingChecks,
  type NoticePostOutcome,
} from "./notice-post.ts";
export {
  MAX_REPOST_ATTEMPTS,
  MOVED_BELOW_TEXT,
  SETTLED_ABOVE_TEXT,
  repostTxnId,
} from "./escalation-repost.ts";
export {
  CHECK_OVERRIDE_COMMENT_REQUIRED_TEXT,
  PULL_BACK_COMMENT_REQUIRED_TEXT,
  checkOverrideRefusalText,
  createCheckOverrides,
  createPullBacks,
  pullBackRefusalText,
  type MarkedAnswers,
  type PersonCallOutcome,
} from "./pull-back.ts";
export {
  SWEEP_MAX_BACKOFF,
  startGateSweep,
  sweepGates,
  type GateSweepDeps,
  type GateSweepResult,
  type GateSweeper,
} from "./gate-sweep.ts";
export {
  AccountsError,
  AssertionMismatch,
  SERVICE_TOKEN_MARGIN_MS,
  assertionFailureCode,
  createAccounts,
  createServiceTokens,
  type Accounts,
  type SenderPrincipal,
  type ServiceTokens,
} from "./accounts.ts";
export {
  SuperpipelineError,
  answerAttentionAtSuperpipeline,
  answerFollowupAtSuperpipeline,
  answerQuestionAtSuperpipeline,
  createSuperpipelineReads,
  overrideCheckAtSuperpipeline,
  pullBackAtSuperpipeline,
  resolveGateAtSuperpipeline,
  type AttentionAction,
  type AttentionAnswerInput,
  type BoardGate,
  type CheckOverrideInput,
  type PullBackInput,
  type FollowupAnswerInput,
  type QuestionAnswerInput,
  type ResolveInput,
  type ResolveResult,
  type SuperpipelineReads,
} from "./superpipeline.ts";
export { startSweeper } from "./sweeper.ts";
export {
  BOARD_ROOM_NAMES,
  NAMESPACE_USER_PREFIX,
  createBoardRooms,
  describe,
  type BoardRooms,
  type BoardRoomsDeps,
} from "./rooms.ts";
export {
  RoomRefused,
  createRoomSender,
  type RoomRefusal,
  type RoomSender,
  type RoomSenderDeps,
} from "./room-sender.ts";
