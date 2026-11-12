/**
 * Speaking in a board room, encrypted when the room is.
 *
 * Every event board chat sends (the gate's prose and card, a reply to an answer, the receipt)
 * goes through here, and the room's recorded encryption decides how (the hub's
 * `crypto-send.ts`, with the decision taken from the store rather than a state read per send):
 *
 *     encrypted room  ─▶ share the room key with its people, encrypt, send `m.room.encrypted`
 *     plaintext room  ─▶ sent as it is, only while `SUPEREXCHANGE_PLAINTEXT_ROOMS` is on
 *
 * Never the other way round, and never a fallback: an encrypted room has told its people their
 * messages are private, so no plaintext is sent into it whatever the setting; and a room made in
 * plaintext is left as it is, never posted into encrypted nor converted. With the setting off it
 * is not spoken in at all: an operator who wants that board's chat back re-opts it in for a new
 * room (not built yet).
 *
 * The room key goes to everyone joined, read from the homeserver per send (somebody who joined a
 * moment ago and is missing from a stale list would get a message they cannot read), and to the
 * people invited and not yet joined, so a gate is readable by whoever accepts the invite next.
 */
import {
  ENCRYPTED_EVENT_TYPE,
  type AppserviceClient,
  type RoomCrypto,
} from "../appservice/index.ts";
import type { BoardRoom, Store } from "../store/index.ts";

/** Why a room is not spoken in. */
export type RoomRefusal = "plaintext room" | "encryption unavailable";

export class RoomRefused extends Error {
  constructor(readonly reason: RoomRefusal | "not a board room") {
    super(`the room is not spoken in: ${reason}`);
    this.name = "RoomRefused";
  }
}

export interface RoomSenderDeps {
  store: Pick<Store, "boardRoomByRoomId" | "membersOf">;
  client: Pick<AppserviceClient, "sendEvent" | "joinedMembers">;
  /** The speaker's encryption; null when no passphrase is set and nothing can be encrypted. */
  crypto: RoomCrypto | null;
  /** `SUPEREXCHANGE_PLAINTEXT_ROOMS`. */
  plaintextRooms: boolean;
}

export interface RoomSender extends Pick<AppserviceClient, "sendEvent"> {
  /** Why this room may not be spoken in, or null when it may. */
  refusal(room: Pick<BoardRoom, "encrypted">): RoomRefusal | null;
}

export function createRoomSender(deps: RoomSenderDeps): RoomSender {
  const { store, client, crypto } = deps;

  function refusal(room: Pick<BoardRoom, "encrypted">): RoomRefusal | null {
    if (room.encrypted)
      return crypto === null ? "encryption unavailable" : null;
    return deps.plaintextRooms ? null : "plaintext room";
  }

  return {
    refusal,

    async sendEvent(asUser, roomId, eventType, txnId, content) {
      const room = store.boardRoomByRoomId(roomId);
      if (room === null) throw new RoomRefused("not a board room");
      const refused = refusal(room);
      if (refused !== null) throw new RoomRefused(refused);
      if (!room.encrypted || crypto === null) {
        return client.sendEvent(asUser, roomId, eventType, txnId, content);
      }
      const joined = await client.joinedMembers(asUser, roomId);
      const members = [
        ...new Set([asUser, ...joined, ...store.membersOf(roomId, "invite")]),
      ];
      const envelope = await crypto.encrypt(
        roomId,
        members,
        eventType,
        content,
      );
      // The same transaction id on every try: a retry re-encrypts, and the homeserver answers it
      // with the first send's event rather than a second message.
      return client.sendEvent(
        asUser,
        roomId,
        ENCRYPTED_EVENT_TYPE,
        txnId,
        envelope,
      );
    },
  };
}
