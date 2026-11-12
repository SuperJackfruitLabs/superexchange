/**
 * Each board's room (and whether it is end-to-end encrypted), who is in it, and the link hints
 * told there.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { BoardRoom, Store } from "./model.ts";

interface BoardRoomRow {
  board_id: string;
  room_id: string;
  alias: string;
  encrypted: number;
  created_at: string;
}

const toBoardRoom = (row: BoardRoomRow): BoardRoom => ({
  boardId: row.board_id,
  roomId: row.room_id,
  alias: row.alias,
  encrypted: row.encrypted === 1,
  createdAt: row.created_at,
});

export type RoomsQueries = Pick<
  Store,
  | "recordBoardRoom"
  | "boardRoom"
  | "boardRoomByRoomId"
  | "recordMembership"
  | "membersOf"
  | "membershipOf"
  | "claimLinkHint"
>;

export function roomsQueries(db: Database, stamp: () => string): RoomsQueries {
  const boardRoom = (boardId: string): BoardRoom | null => {
    const row = db
      .query<
        BoardRoomRow,
        [string]
      >("SELECT * FROM board_rooms WHERE board_id = ?")
      .get(boardId);
    return row ? toBoardRoom(row) : null;
  };

  return {
    recordBoardRoom(boardId, roomId, alias, encrypted) {
      db.query(
        "INSERT INTO board_rooms (board_id, room_id, alias, encrypted, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (board_id) DO NOTHING",
      ).run(boardId, roomId, alias, encrypted ? 1 : 0, stamp());
      return boardRoom(boardId) as BoardRoom;
    },

    boardRoom,

    boardRoomByRoomId(roomId) {
      const row = db
        .query<
          BoardRoomRow,
          [string]
        >("SELECT * FROM board_rooms WHERE room_id = ?")
        .get(roomId);
      return row ? toBoardRoom(row) : null;
    },

    recordMembership(roomId, userId, membership) {
      db.query(
        `INSERT INTO room_members (room_id, user_id, membership, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, user_id) DO UPDATE SET
           membership = excluded.membership,
           updated_at = excluded.updated_at`,
      ).run(roomId, userId, membership, stamp());
    },

    membersOf(roomId, membership) {
      return db
        .query<{ user_id: string }, [string, string]>(
          "SELECT user_id FROM room_members WHERE room_id = ? AND membership = ? ORDER BY user_id",
        )
        .all(roomId, membership)
        .map((row) => row.user_id);
    },

    membershipOf(roomId, userId) {
      const row = db
        .query<
          { membership: string },
          [string, string]
        >("SELECT membership FROM room_members WHERE room_id = ? AND user_id = ?")
        .get(roomId, userId);
      return row?.membership ?? null;
    },

    claimLinkHint(sender, roomId, day) {
      db.query("DELETE FROM link_hints WHERE day < ?").run(day);
      const result = db
        .query(
          "INSERT OR IGNORE INTO link_hints (sender, room_id, day) VALUES (?, ?, ?)",
        )
        .run(sender, roomId, day);
      return result.changes === 1;
    },
  };
}
