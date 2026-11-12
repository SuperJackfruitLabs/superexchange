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
 * - `accounts.ts`: the organization plane: who a sender is, and the assertion that carries them.
 * - `superpipeline.ts`: resolving a gate at SuperPipeline with that assertion.
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
  AccountsError,
  AssertionMismatch,
  assertionFailureCode,
  createAccounts,
  type Accounts,
  type SenderPrincipal,
} from "./accounts.ts";
export {
  resolveGateAtSuperpipeline,
  type ResolveInput,
  type ResolveResult,
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
