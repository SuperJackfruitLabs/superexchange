/**
 * Call clients' delayed leaves (superdial), keyed by LiveKit room and identity.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { DelayedLeave, Store } from "./model.ts";

export type CallsQueries = Pick<
  Store,
  | "recordDelayedLeave"
  | "delayedLeaves"
  | "markDelayedLeaveConnected"
  | "forgetDelayedLeave"
>;

interface Row {
  livekit_room: string;
  identity: string;
  user_id: string;
  room_id: string;
  delay_id: string;
  registered_at: string;
  connected_at: string | null;
}

const fromRow = (row: Row): DelayedLeave => ({
  livekitRoom: row.livekit_room,
  identity: row.identity,
  userId: row.user_id,
  roomId: row.room_id,
  delayId: row.delay_id,
  registeredAt: row.registered_at,
  connectedAt: row.connected_at,
});

export function callsQueries(db: Database, stamp: () => string): CallsQueries {
  return {
    recordDelayedLeave(input) {
      const registeredAt = stamp();
      db.query(
        `INSERT INTO delayed_leaves (livekit_room, identity, user_id, room_id, delay_id, registered_at, connected_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (livekit_room, identity) DO UPDATE SET
           user_id = excluded.user_id, room_id = excluded.room_id, delay_id = excluded.delay_id,
           registered_at = excluded.registered_at, connected_at = NULL`,
      ).run(
        input.livekitRoom,
        input.identity,
        input.userId,
        input.roomId,
        input.delayId,
        registeredAt,
      );
      return { ...input, registeredAt, connectedAt: null };
    },

    delayedLeaves() {
      return db
        .query<
          Row,
          []
        >("SELECT * FROM delayed_leaves ORDER BY registered_at, livekit_room, identity")
        .all()
        .map(fromRow);
    },

    markDelayedLeaveConnected(livekitRoom, identity, delayId) {
      return (
        db
          .query(
            "UPDATE delayed_leaves SET connected_at = COALESCE(connected_at, ?) WHERE livekit_room = ? AND identity = ? AND delay_id = ?",
          )
          .run(stamp(), livekitRoom, identity, delayId).changes === 1
      );
    },

    forgetDelayedLeave(livekitRoom, identity, delayId) {
      return (
        db
          .query(
            "DELETE FROM delayed_leaves WHERE livekit_room = ? AND identity = ? AND delay_id = ?",
          )
          .run(livekitRoom, identity, delayId).changes === 1
      );
    },
  };
}
