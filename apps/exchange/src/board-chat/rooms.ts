/**
 * The room a board's gates close in, and who is in it.
 *
 * Ported from the AgentPod hub's `services/board-chat/board-room.ts`: a board has one room, made
 * once by the board's speaker, recorded, and its people invited. The names are treaty's
 * (`boardRoomNames("superexchange")`): the speaker `@superexchange_board` and the alias
 * `#superexchange_board_<board id>`, both inside this appservice's exclusive namespace, so a
 * board's room here is never the room the hub made for it.
 *
 * A gate is held until a person has JOINED the room, not merely been invited (the hub's
 * `boardRoomHasJoinedHuman`, an operator rule): a card sent before anybody can read it is a card
 * nobody answers. Memberships are kept from the homeserver's transactions; when none is on
 * record, the room's joined members are asked once.
 */
import {
  BOARD_SPEAKER_DISPLAY_NAME,
  boardRoomNames,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  MatrixClientError,
  type AppserviceClient,
} from "../appservice/index.ts";
import type { Board, BoardRoom, Store } from "../store/index.ts";

/** This carrier's board-room names. */
export const BOARD_ROOM_NAMES = boardRoomNames("superexchange");

/**
 * The start of every user id in this appservice's namespace. A member who starts with it is this
 * service speaking, never a person who can read a card.
 */
export const NAMESPACE_USER_PREFIX = "@superexchange_";

/** The power level the speaker holds in its rooms. */
const SPEAKER_POWER = 100;

export interface BoardRoomsDeps {
  store: Pick<
    Store,
    | "boardRoom"
    | "recordBoardRoom"
    | "recordMembership"
    | "membershipOf"
    | "membersOf"
  >;
  client: Pick<
    AppserviceClient,
    | "register"
    | "setDisplayName"
    | "createRoom"
    | "resolveAlias"
    | "invite"
    | "joinedMembers"
  >;
  serverName: string;
  log: (line: string) => void;
}

export interface BoardRooms {
  /** The speaker's Matrix id. */
  readonly speaker: string;
  /** Is this user a person, not this service? */
  isPerson(userId: string): boolean;
  /**
   * The board's room, made if it is not there yet, with every invitee not already in it or
   * invited, invited. Throws when the room can neither be made nor found.
   */
  ensure(board: Board, boardName?: string): Promise<BoardRoom>;
  /** Has a person joined this room? Throws when the homeserver cannot say. */
  personJoined(roomId: string): Promise<boolean>;
}

export function createBoardRooms(deps: BoardRoomsDeps): BoardRooms {
  const { store, client, log } = deps;
  const speaker = BOARD_ROOM_NAMES.speakerMxid(deps.serverName);
  const isPerson = (userId: string) =>
    !userId.startsWith(NAMESPACE_USER_PREFIX);

  // Registered and named once per process; a failure is not remembered, so the next gate retries.
  let speakerReady: Promise<void> | null = null;
  function ensureSpeaker(): Promise<void> {
    speakerReady ??= (async () => {
      await client.register(BOARD_ROOM_NAMES.speakerLocalpart);
      await client.setDisplayName(speaker, BOARD_SPEAKER_DISPLAY_NAME);
    })().catch((error: unknown) => {
      speakerReady = null;
      throw error;
    });
    return speakerReady;
  }

  /**
   * Invite each invitee not already joined or invited, each on its own: one person who cannot be
   * invited must not cost everybody else their room.
   */
  async function inviteMissing(board: Board, roomId: string): Promise<void> {
    for (const userId of board.invitees) {
      const membership = store.membershipOf(roomId, userId);
      if (membership === "join" || membership === "invite") continue;
      try {
        await client.invite(speaker, roomId, userId);
        store.recordMembership(roomId, userId, "invite");
      } catch (error) {
        log(
          `board-chat: an invitee of ${board.boardId} could not be invited (${describe(error)})`,
        );
      }
    }
  }

  return {
    speaker,
    isPerson,

    async ensure(board, boardName) {
      const existing = store.boardRoom(board.boardId);
      if (existing) {
        // Re-checked for a room we already have: somebody added to the board after its room was
        // made would otherwise never be invited.
        await inviteMissing(board, existing.roomId);
        return existing;
      }

      await ensureSpeaker();
      const alias = BOARD_ROOM_NAMES.alias(board.boardId);
      const name = boardName?.trim() || board.boardId;
      // The first invitee rides on creation, the rest follow one by one (as the hub does): one
      // invite the homeserver refuses must not cost the board its room.
      const [first] = board.invitees;
      let roomId: string;
      let created = false;
      try {
        roomId = await client.createRoom(speaker, {
          aliasLocalpart: alias,
          name,
          topic: `Approvals for ${name}. Answer here and the board hears it.`,
          invite: first ? [first] : [],
          powerLevels: { [speaker]: SPEAKER_POWER },
          // Reached only while SUPEREXCHANGE_PLAINTEXT_ROOMS is on: this service cannot encrypt
          // yet, and a room it cannot post into is no use. Encryption replaces this switch.
          encrypted: false,
        });
        created = true;
      } catch (error) {
        if (!isRoomInUse(error)) throw error;
        // The alias is this namespace's, so the room behind it is this board's: made by an
        // earlier call that did not live to record it. That room is the answer.
        const found = await client.resolveAlias(`#${alias}:${deps.serverName}`);
        if (found === null) throw error;
        roomId = found;
      }

      const recorded = store.recordBoardRoom(board.boardId, roomId, alias);
      store.recordMembership(recorded.roomId, speaker, "join");
      if (created && first)
        store.recordMembership(recorded.roomId, first, "invite");
      await inviteMissing(board, recorded.roomId);
      log(
        `board-chat: ${board.boardId} room ${created ? "made" : "found by its alias"}`,
      );
      return recorded;
    },

    async personJoined(roomId) {
      if (store.membersOf(roomId, "join").some(isPerson)) return true;
      // Nobody on record. Asked once more of the homeserver, in case a join arrived before this
      // service kept memberships; what it says is kept.
      const joined = await client.joinedMembers(speaker, roomId);
      for (const userId of joined)
        store.recordMembership(roomId, userId, "join");
      return joined.some(isPerson);
    },
  };
}

function isRoomInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === "M_ROOM_IN_USE"
  );
}

/**
 * An error as a log may carry it: a client error's message (endpoint, status and errcode only),
 * or else only the error's name, since a message may quote what it failed on.
 */
export function describe(error: unknown): string {
  if (error instanceof MatrixClientError) return error.message;
  return error instanceof Error ? error.name : "unknown";
}
