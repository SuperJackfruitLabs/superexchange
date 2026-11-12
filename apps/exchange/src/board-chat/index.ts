/**
 * Board work in chat: gates, questions, follow-ups and waiting cards projected into board rooms,
 * and the answers carried back to the board. Built on the appservice transport, the store and
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
 * - `accounts.ts`: the organization plane: who a sender is, the assertion that carries them, and
 *   this service's own token for reading boards.
 * - `superpipeline.ts`: resolving a gate at SuperPipeline with that assertion, and reading a
 *   board's gates with that token.
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
  createSuperpipelineReads,
  resolveGateAtSuperpipeline,
  type BoardGate,
  type ResolveInput,
  type ResolveResult,
  type SuperpipelineReads,
} from "./superpipeline.ts";
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
