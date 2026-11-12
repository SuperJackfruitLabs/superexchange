/**
 * Board work in chat: gates, questions, follow-ups and waiting cards projected into board rooms,
 * and the answers carried back to the board. Built on the appservice transport, the store and
 * treaty's board-room contract (`@superjackfruitlabs/treaty-matrix-events`).
 *
 * - `boards.ts`: what an opted-in board is, and the checks on its settings.
 * - `gates.ts`: the relay's `gate.pending` deliveries, kept for opted-in boards.
 * - `rooms.ts`: each board's room, made once, its people invited, and who has joined it.
 * - `gate-card.ts`: posting a kept gate into its room once a person has joined, exactly once.
 *
 * Ported from the AgentPod hub's `services/board-chat`. Nothing is encrypted yet: rooms are made
 * and posted into only while `SUPEREXCHANGE_PLAINTEXT_ROOMS` is on, which only a staging
 * homeserver allows.
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
  createBoardChat,
  gateTxnId,
  type BoardChat,
  type BoardChatDeps,
  type PostOutcome,
} from "./gate-card.ts";
export {
  BOARD_ROOM_NAMES,
  NAMESPACE_USER_PREFIX,
  createBoardRooms,
  type BoardRooms,
  type BoardRoomsDeps,
} from "./rooms.ts";
