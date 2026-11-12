/**
 * The checks.waiting cards: which arrival each stands for, where it was posted, and whether it is
 * closed.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { ChecksWaiting, Store } from "./model.ts";

interface ChecksWaitingRow {
  board_id: string;
  arrival_id: string;
  card_id: string;
  card_title: string;
  stage_key: string;
  stage_name: string | null;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  closed_at: string | null;
}

const toChecksWaiting = (row: ChecksWaitingRow): ChecksWaiting => ({
  boardId: row.board_id,
  arrivalId: row.arrival_id,
  cardId: row.card_id,
  cardTitle: row.card_title,
  stageKey: row.stage_key,
  stageName: row.stage_name,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  closedAt: row.closed_at,
});

export type ChecksQueries = Pick<
  Store,
  | "claimChecksWaiting"
  | "checksWaiting"
  | "recordChecksWaitingPosted"
  | "checksWaitingByEvent"
  | "openChecksWaiting"
  | "closeChecksWaiting"
  | "moveChecksWaiting"
>;

export function checksQueries(
  db: Database,
  stamp: () => string,
): ChecksQueries {
  return {
    claimChecksWaiting(input) {
      return (
        db
          .query(
            `INSERT INTO checks_waiting (board_id, arrival_id, card_id, card_title, stage_key, stage_name, room_id, claimed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (board_id, arrival_id) DO NOTHING`,
          )
          .run(
            input.boardId,
            input.arrivalId,
            input.cardId,
            input.cardTitle,
            input.stageKey,
            input.stageName,
            input.roomId,
            stamp(),
          ).changes === 1
      );
    },

    checksWaiting(boardId, arrivalId) {
      const row = db
        .query<
          ChecksWaitingRow,
          [string, string]
        >("SELECT * FROM checks_waiting WHERE board_id = ? AND arrival_id = ?")
        .get(boardId, arrivalId);
      return row ? toChecksWaiting(row) : null;
    },

    recordChecksWaitingPosted(boardId, arrivalId, eventId) {
      db.query(
        "UPDATE checks_waiting SET event_id = ?, posted_at = ? WHERE board_id = ? AND arrival_id = ?",
      ).run(eventId, stamp(), boardId, arrivalId);
    },

    checksWaitingByEvent(eventId) {
      const row = db
        .query<
          ChecksWaitingRow,
          [string]
        >("SELECT * FROM checks_waiting WHERE event_id = ? AND posted_at IS NOT NULL")
        .get(eventId);
      return row ? toChecksWaiting(row) : null;
    },

    openChecksWaiting(boardId, cardId, stageKey, roomId) {
      const row = db
        .query<ChecksWaitingRow, [string, string, string, string]>(
          `SELECT * FROM checks_waiting
           WHERE board_id = ? AND card_id = ? AND stage_key = ? AND room_id = ?
             AND posted_at IS NOT NULL AND closed_at IS NULL
           ORDER BY claimed_at DESC, arrival_id DESC LIMIT 1`,
        )
        .get(boardId, cardId, stageKey, roomId);
      return row ? toChecksWaiting(row) : null;
    },

    closeChecksWaiting(boardId, arrivalId) {
      db.query(
        "UPDATE checks_waiting SET closed_at = ? WHERE board_id = ? AND arrival_id = ? AND closed_at IS NULL",
      ).run(stamp(), boardId, arrivalId);
    },

    moveChecksWaiting(boardId, arrivalId, was, to) {
      return (
        db
          .query(
            `UPDATE checks_waiting SET event_id = ?
             WHERE board_id = ? AND arrival_id = ? AND event_id = ? AND closed_at IS NULL`,
          )
          .run(to, boardId, arrivalId, was).changes === 1
      );
    },
  };
}
