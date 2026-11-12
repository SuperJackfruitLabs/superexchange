/**
 * The waiting cards the relay delivered, and the ones posted.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { AttentionEvent, CardOfferOption, Store } from "./model.ts";

interface AttentionEventRow {
  board_id: string;
  card_id: string;
  wait_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toAttentionEvent = (row: AttentionEventRow): AttentionEvent => ({
  boardId: row.board_id,
  cardId: row.card_id,
  waitId: row.wait_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  options: JSON.parse(row.options) as CardOfferOption[],
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

export type AttentionQueries = Pick<
  Store,
  | "recordAttentionDelivery"
  | "attentionDelivery"
  | "unpostedAttention"
  | "settleAttentionDelivery"
  | "claimAttentionEvent"
  | "attentionEvent"
  | "recordAttentionPosted"
  | "claimAttentionReceipt"
  | "settleAttentionEvent"
  | "postedAttentionAwaitingOutcome"
  | "moveAttentionEvent"
>;

export function attentionQueries(
  db: Database,
  stamp: () => string,
): AttentionQueries {
  return {
    recordAttentionDelivery(key, body) {
      return (
        db
          .query(
            `INSERT INTO attention_deliveries (board_id, card_id, wait_id, received_at, body)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (board_id, card_id, wait_id) DO NOTHING`,
          )
          .run(
            key.boardId,
            key.cardId,
            key.waitId,
            stamp(),
            JSON.stringify(body),
          ).changes === 1
      );
    },

    attentionDelivery(key) {
      const row = db
        .query<
          { body: string; settled_at: string | null },
          [string, string, string]
        >("SELECT body, settled_at FROM attention_deliveries WHERE board_id = ? AND card_id = ? AND wait_id = ?")
        .get(key.boardId, key.cardId, key.waitId);
      return row
        ? { body: JSON.parse(row.body) as unknown, settledAt: row.settled_at }
        : null;
    },

    unpostedAttention(boardId) {
      return db
        .query<
          { board_id: string; card_id: string; wait_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.board_id, d.card_id, d.wait_id, d.body FROM attention_deliveries d
           LEFT JOIN attention_events e
             ON e.board_id = d.board_id AND e.card_id = d.card_id AND e.wait_id = d.wait_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.board_id, d.card_id, d.wait_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          boardId: row.board_id,
          cardId: row.card_id,
          waitId: row.wait_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleAttentionDelivery(key) {
      return (
        db
          .query(
            "UPDATE attention_deliveries SET settled_at = ? WHERE board_id = ? AND card_id = ? AND wait_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    claimAttentionEvent(key, roomId, options) {
      return (
        db
          .query(
            `INSERT INTO attention_events (board_id, card_id, wait_id, room_id, claimed_at, options)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (board_id, card_id, wait_id) DO NOTHING`,
          )
          .run(
            key.boardId,
            key.cardId,
            key.waitId,
            roomId,
            stamp(),
            JSON.stringify(options),
          ).changes === 1
      );
    },

    attentionEvent(key) {
      const row = db
        .query<
          AttentionEventRow,
          [string, string, string]
        >("SELECT * FROM attention_events WHERE board_id = ? AND card_id = ? AND wait_id = ?")
        .get(key.boardId, key.cardId, key.waitId);
      return row ? toAttentionEvent(row) : null;
    },

    recordAttentionPosted(key, eventId) {
      db.query(
        "UPDATE attention_events SET event_id = ?, posted_at = ? WHERE board_id = ? AND card_id = ? AND wait_id = ?",
      ).run(eventId, stamp(), key.boardId, key.cardId, key.waitId);
    },

    claimAttentionReceipt(key) {
      return (
        db
          .query(
            `UPDATE attention_events SET outcome_posted_at = ?
             WHERE board_id = ? AND card_id = ? AND wait_id = ?
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    settleAttentionEvent(key) {
      return (
        db
          .query(
            `UPDATE attention_events SET outcome_posted_at = ?1, settled_at = ?1
             WHERE board_id = ?2 AND card_id = ?3 AND wait_id = ?4
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    postedAttentionAwaitingOutcome(boardId) {
      return db
        .query<AttentionEventRow, [string]>(
          `SELECT * FROM attention_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toAttentionEvent);
    },

    moveAttentionEvent(key, was, to) {
      return (
        db
          .query(
            `UPDATE attention_events SET event_id = ?
             WHERE board_id = ? AND card_id = ? AND wait_id = ? AND event_id = ? AND outcome_posted_at IS NULL`,
          )
          .run(to, key.boardId, key.cardId, key.waitId, was).changes === 1
      );
    },
  };
}
