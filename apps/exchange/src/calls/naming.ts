/**
 * The names a call is known by in LiveKit (C5), the shapes of the ids a caller sends, and the one
 * error the token service's upstreams throw.
 *
 * - The LiveKit identity is `{user_id}:{device_id}`: one form, so a receiver registers a sender's
 *   media key under it only.
 * - The LiveKit room is the unpadded base64url of the SHA-256 of the Matrix room id (UTF-8).
 */
import { createHash } from "node:crypto";

export function livekitIdentity(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export function livekitRoomName(roomId: string): string {
  return createHash("sha256").update(roomId, "utf8").digest("base64url");
}

/** A Matrix room id: `!`, an opaque part, `:`, a server name; at most 255 characters. */
export function isRoomId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    /^![^\s:]+:\S+$/.test(value)
  );
}

/** One to 255 printable characters, no space: a device id or a delay id as a homeserver issues them. */
const OPAQUE_ID = /^[\x21-\x7e]{1,255}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function isDelayId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

/**
 * An upstream of the token service (the homeserver, the hub, LiveKit) could not give an answer.
 * Never carries the underlying error: a fetch error can quote its URL, and the OpenID check's URL
 * carries the caller's token.
 */
export class CallUpstreamError extends Error {
  constructor(
    readonly service: "homeserver" | "hub" | "livekit",
    readonly detail: string,
  ) {
    super(`the ${service} could not answer (${detail})`);
    this.name = "CallUpstreamError";
  }
}
