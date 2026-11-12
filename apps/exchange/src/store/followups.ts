/**
 * The delivery follow-ups the relay delivered, and the ones posted.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { CardOfferOption, FollowupEvent, Store } from "./model.ts";

interface FollowupEventRow {
  gate_id: string;
  board_id: string;
  card_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  subject_preview_complete: number | null;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toFollowupEvent = (row: FollowupEventRow): FollowupEvent => ({
  gateId: row.gate_id,
  boardId: row.board_id,
  cardId: row.card_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  offer: {
    options: JSON.parse(row.options) as CardOfferOption[],
    subjectPreviewComplete:
      row.subject_preview_complete === null
        ? null
        : row.subject_preview_complete === 1,
  },
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

export type FollowupsQueries = Pick<
  Store,
  | "recordFollowupDelivery"
  | "followupDelivery"
  | "unpostedFollowups"
  | "settleFollowupDelivery"
  | "claimFollowupEvent"
  | "followupEvent"
  | "recordFollowupPosted"
  | "claimFollowupReceipt"
  | "settleFollowupEvent"
  | "postedFollowupsAwaitingOutcome"
  | "moveFollowupEvent"
>;

export function followupsQueries(
  db: Database,
  stamp: () => string,
): FollowupsQueries {
  return {
    recordFollowupDelivery(gateId, boardId, body) {
      return (
        db
          .query(
            "INSERT INTO followup_deliveries (gate_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING",
          )
          .run(gateId, boardId, stamp(), JSON.stringify(body)).changes === 1
      );
    },

    followupDelivery(gateId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM followup_deliveries WHERE gate_id = ?")
        .get(gateId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    unpostedFollowups(boardId) {
      return db
        .query<
          { gate_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.gate_id, d.board_id, d.body FROM followup_deliveries d
           LEFT JOIN followup_events e ON e.gate_id = d.gate_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.gate_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          gateId: row.gate_id,
          boardId: row.board_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleFollowupDelivery(gateId) {
      return (
        db
          .query(
            "UPDATE followup_deliveries SET settled_at = ? WHERE gate_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    claimFollowupEvent(gateId, boardId, cardId, roomId, offer) {
      return (
        db
          .query(
            `INSERT INTO followup_events (gate_id, board_id, card_id, room_id, claimed_at, options,
               subject_preview_complete)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING`,
          )
          .run(
            gateId,
            boardId,
            cardId,
            roomId,
            stamp(),
            JSON.stringify(offer.options),
            offer.subjectPreviewComplete === null
              ? null
              : offer.subjectPreviewComplete
                ? 1
                : 0,
          ).changes === 1
      );
    },

    followupEvent(gateId) {
      const row = db
        .query<
          FollowupEventRow,
          [string]
        >("SELECT * FROM followup_events WHERE gate_id = ?")
        .get(gateId);
      return row ? toFollowupEvent(row) : null;
    },

    recordFollowupPosted(gateId, eventId) {
      db.query(
        "UPDATE followup_events SET event_id = ?, posted_at = ? WHERE gate_id = ?",
      ).run(eventId, stamp(), gateId);
    },

    claimFollowupReceipt(gateId) {
      return (
        db
          .query(
            "UPDATE followup_events SET outcome_posted_at = ? WHERE gate_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    settleFollowupEvent(gateId) {
      return (
        db
          .query(
            "UPDATE followup_events SET outcome_posted_at = ?1, settled_at = ?1 WHERE gate_id = ?2 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    postedFollowupsAwaitingOutcome(boardId) {
      return db
        .query<FollowupEventRow, [string]>(
          `SELECT * FROM followup_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toFollowupEvent);
    },

    moveFollowupEvent(gateId, was, to) {
      return (
        db
          .query(
            "UPDATE followup_events SET event_id = ? WHERE gate_id = ? AND event_id = ? AND outcome_posted_at IS NULL",
          )
          .run(to, gateId, was).changes === 1
      );
    },
  };
}
