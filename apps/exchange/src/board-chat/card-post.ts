/**
 * Posting one single-event card (a delivery follow-up, a waiting card) into its board's room,
 * exactly once. The order is a question's (`question-card.ts`), which is a gate's (`gate-card.ts`):
 *
 * 1. the board's room, made once (`rooms.ts`);
 * 2. fail closed on encryption (`room-sender.ts`): nothing is claimed in a room that may not be
 *    spoken in;
 * 3. held until a person has joined, with no claim taken, so nothing typed in the room can be taken
 *    as an answer to a card nobody was shown;
 * 4. the claim, with what the card offers, before anything is sent;
 * 5. the send under a transaction id derived from the card, so a retry of a claimed, unfinished
 *    card is answered by the homeserver with the first send's event. A failed send keeps its claim:
 *    the next join, boot or sweep sends it again under the same id. (The hub gives the claim back
 *    instead; this service never needs to, because the id makes the retry the same message.)
 *
 * The caller has checked the delivery (recorded, not settled, its shape) and its board.
 */
import type { Board, BoardRoom, Store } from "../store/index.ts";
import type { RoomRefusal, RoomSender } from "./room-sender.ts";
import { describe, type BoardRooms } from "./rooms.ts";

/** One card, as the post needs it. */
export interface SingleCard {
  /** How a log names it, e.g. `follow-up "gate_1"`. Never its content. */
  at: string;
  /** The key its hold is logged once under. */
  heldKey: string;
  board: Board;
  boardName: string | null;
  /** Its claim, or null. */
  claimed(): { roomId: string; postedAt: string | null } | null;
  /** Take the claim in this room, with what it offers. */
  claim(roomId: string): void;
  recordPosted(eventId: string): void;
  txnId: string;
  content(): Record<string, unknown>;
}

export type CardPostOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "held"; roomId: string }
  | { status: "refused"; reason: RoomRefusal }
  | { status: "failed"; step: "room" | "membership" | "send" };

export interface CardPostDeps {
  store: Pick<Store, "boardRoom" | "boardRoomByRoomId">;
  sender: RoomSender;
  rooms: BoardRooms;
  /** Null when the room may be spoken in; else the refusal, logged once per board by the caller. */
  refuse(
    boardId: string,
    room: Pick<BoardRoom, "encrypted">,
  ): RoomRefusal | null;
  /** Log a card's hold once, under its key. */
  held(key: string, at: string, boardId: string): void;
  log: (line: string) => void;
}

/** Post one card. Run only in board chat's queue. */
export async function postCard(
  deps: CardPostDeps,
  card: SingleCard,
): Promise<CardPostOutcome> {
  const { store, sender, rooms, log } = deps;
  const { board, at } = card;
  const claimed = card.claimed();
  if (claimed?.postedAt) return { status: "already" };

  const known = claimed
    ? store.boardRoomByRoomId(claimed.roomId)
    : store.boardRoom(board.boardId);
  if (known) {
    const reason = deps.refuse(board.boardId, known);
    if (reason) return { status: "refused", reason };
  }

  if (!claimed) {
    let roomId: string;
    try {
      const room = await rooms.ensure(board, card.boardName ?? undefined);
      const reason = deps.refuse(board.boardId, room);
      if (reason) return { status: "refused", reason };
      roomId = room.roomId;
    } catch (error) {
      log(
        `board-chat: ${at} has no room on ${board.boardId} (${describe(error)})`,
      );
      return { status: "failed", step: "room" };
    }
    try {
      if (!(await rooms.personJoined(roomId))) {
        deps.held(card.heldKey, at, board.boardId);
        return { status: "held", roomId };
      }
    } catch (error) {
      log(
        `board-chat: ${at} held: the room's members could not be read (${describe(error)})`,
      );
      return { status: "failed", step: "membership" };
    }
    card.claim(roomId);
  }

  const claim = card.claimed();
  if (claim === null) return { status: "failed", step: "send" };
  try {
    const eventId = await sender.sendEvent(
      rooms.speaker,
      claim.roomId,
      "m.room.message",
      card.txnId,
      card.content(),
    );
    card.recordPosted(eventId);
    log(`board-chat: ${at} posted on ${board.boardId}`);
    return { status: "posted", roomId: claim.roomId, eventId };
  } catch (error) {
    // The claim stays: the next join, boot or sweep sends it under the same id.
    log(
      `board-chat: ${at} not posted on ${board.boardId} (${describe(error)}); it is retried at the next join, boot or sweep`,
    );
    return { status: "failed", step: "send" };
  }
}
