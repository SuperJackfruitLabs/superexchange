/**
 * LiveKit, as the token service needs it: a join token for one identity in one room, a webhook
 * read only when LiveKit signed it, and whether an identity is in a room now (the server API's
 * `GetParticipant`).
 */
import {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import type { SuperdialConfig } from "../config.ts";
import { CallUpstreamError } from "./naming.ts";

/**
 * How long a join token is good for, in seconds. Short: it is checked only when the caller
 * connects, and LiveKit refreshes a joined participant's token itself.
 */
export const TOKEN_TTL_SECONDS = 600;

/**
 * How long a server API call (a presence check) may take. Under the delayed-leave loop's restart
 * interval, so a blackholed API answers "cannot say" before the next pass.
 */
export const LIVEKIT_API_TIMEOUT_MS = 2_500;

/** What the delayed-leave loop reads from a webhook. */
export interface LiveKitEvent {
  /** `participant_joined`, `participant_left`, `participant_connection_aborted`, `room_finished`, … */
  event: string;
  room: string | null;
  identity: string | null;
  /**
   * The participant's session id (`PA_…`): one identity has a new one each time it joins, and a
   * rejoin under the same identity removes the old session with its own `participant_left`.
   * Absent or null when the event names no participant.
   */
  participantSid?: string | null;
}

export interface LiveKit {
  /** The public URL callers connect to. */
  url: string;
  /** A join token for `identity` in `room` only: publish, subscribe, set its own attributes. */
  mint(identity: string, userId: string, room: string): Promise<string>;
  /** The webhook's event, or null when it is not signed with this key's secret over this body. */
  receive(
    body: string,
    authorization: string | null,
  ): Promise<LiveKitEvent | null>;
  /** Is `identity` in `room` now? Throws `CallUpstreamError` when LiveKit cannot say. */
  isConnected(room: string, identity: string): Promise<boolean>;
}

export interface LiveKitDeps {
  /** Test seam: the server API. */
  rooms?: Pick<RoomServiceClient, "getParticipant">;
}

export function createLiveKit(
  settings: Pick<
    SuperdialConfig,
    "livekitUrl" | "livekitApiUrl" | "livekitApiKey" | "livekitApiSecret"
  >,
  deps: LiveKitDeps = {},
): LiveKit {
  const { livekitApiKey: key, livekitApiSecret: secret } = settings;
  const receiver = new WebhookReceiver(key, secret);
  const rooms =
    deps.rooms ??
    new RoomServiceClient(settings.livekitApiUrl, key, secret, {
      // In seconds.
      requestTimeout: LIVEKIT_API_TIMEOUT_MS / 1000,
    });

  return {
    url: settings.livekitUrl,

    async mint(identity, userId, room) {
      const token = new AccessToken(key, secret, {
        identity,
        name: userId,
        ttl: TOKEN_TTL_SECONDS,
      });
      token.addGrant({
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
        // superdial-agent shows its call state as its own participant attribute (C6).
        canUpdateOwnMetadata: true,
      });
      return token.toJwt();
    },

    async receive(body, authorization) {
      if (authorization === null || authorization === "") return null;
      try {
        const event = await receiver.receive(body, authorization);
        return {
          event: event.event,
          room: event.room?.name || null,
          identity: event.participant?.identity || null,
          participantSid: event.participant?.sid || null,
        };
      } catch {
        return null;
      }
    },

    async isConnected(room, identity) {
      try {
        await rooms.getParticipant(room, identity);
        return true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "not_found"
        ) {
          return false;
        }
        throw new CallUpstreamError("livekit", "presence");
      }
    },
  };
}
