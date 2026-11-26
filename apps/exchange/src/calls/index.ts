/**
 * Calls (superdial): the LiveKit token service and the cleanup after a dead call client (C5).
 * Above the store; it knows no board, and reaches the homeserver only by the tokenless routes it
 * is allowed (OpenID userinfo, the MSC4140 delayed-event action).
 *
 * - `naming.ts`: the LiveKit identity and room name, id shapes, the upstream error.
 * - `livekit.ts`: tokens, webhooks, presence.
 */
export {
  CallUpstreamError,
  isDelayId,
  isDeviceId,
  isRoomId,
  livekitIdentity,
  livekitRoomName,
} from "./naming.ts";
export {
  TOKEN_TTL_SECONDS,
  createLiveKit,
  type LiveKit,
  type LiveKitDeps,
  type LiveKitEvent,
} from "./livekit.ts";
