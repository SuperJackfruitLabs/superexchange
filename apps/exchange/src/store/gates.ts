/**
 * The gates the event relay delivered, and the ones posted: what each offered, its quorum, whether
 * an answer has acted and its receipt been posted, and which the board says were decided
 * elsewhere.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type {
  GateEvent,
  GateOfferOption,
  GateOfferVariant,
  Store,
} from "./model.ts";

interface GateEventRow {
  gate_id: string;
  board_id: string;
  room_id: string;
  card_event_id: string | null;
  prose_event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string | null;
  subject_id: string | null;
  subject_digest: string | null;
  subject_preview_complete: number | null;
  variants: string | null;
  quorum: string | null;
  outcome_claimed_at: string | null;
  outcome_posted_at: string | null;
  settled_at: string | null;
  settled_decision: string | null;
}

const toGateEvent = (row: GateEventRow): GateEvent => ({
  gateId: row.gate_id,
  boardId: row.board_id,
  roomId: row.room_id,
  cardEventId: row.card_event_id,
  proseEventId: row.prose_event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  // No options means the gate was claimed before offers were recorded: it offered nothing known.
  offer:
    row.options === null
      ? null
      : {
          options: JSON.parse(row.options) as GateOfferOption[],
          subjectId: row.subject_id,
          subjectDigest: row.subject_digest,
          subjectPreviewComplete:
            row.subject_preview_complete === null
              ? null
              : row.subject_preview_complete === 1,
          variants:
            row.variants === null
              ? null
              : (JSON.parse(row.variants) as GateOfferVariant[]),
          quorum:
            row.quorum === null ? null : (JSON.parse(row.quorum) as unknown),
        },
  outcomeClaimedAt: row.outcome_claimed_at,
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
  settledDecision: row.settled_decision,
});

export type GatesQueries = Pick<
  Store,
  | "recordGateDelivery"
  | "gateDelivery"
  | "settleGateDelivery"
  | "unpostedGates"
  | "claimGateEvent"
  | "gateEvent"
  | "recordGateProse"
  | "recordGatePosted"
  | "claimGateOutcome"
  | "releaseGateOutcome"
  | "claimGateReceipt"
  | "settleGateEvent"
  | "postedGatesAwaitingOutcome"
  | "releaseUnfinishedOutcomes"
  | "moveGateEvent"
  | "recordGateQuorum"
>;

export function gatesQueries(db: Database, stamp: () => string): GatesQueries {
  return {
    recordGateDelivery(gateId, boardId, body) {
      const result = db
        .query(
          "INSERT INTO gate_deliveries (gate_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING",
        )
        .run(gateId, boardId, stamp(), JSON.stringify(body));
      return result.changes === 1;
    },

    gateDelivery(gateId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM gate_deliveries WHERE gate_id = ?")
        .get(gateId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    settleGateDelivery(gateId) {
      return (
        db
          .query(
            "UPDATE gate_deliveries SET settled_at = ? WHERE gate_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    unpostedGates(boardId) {
      const rows = db
        .query<
          { gate_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.gate_id, d.board_id, d.body FROM gate_deliveries d
           LEFT JOIN gate_events e ON e.gate_id = d.gate_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.gate_id`,
        )
        .all(boardId ?? null, boardId ?? null);
      return rows.map((row) => ({
        gateId: row.gate_id,
        boardId: row.board_id,
        body: JSON.parse(row.body) as unknown,
      }));
    },

    claimGateEvent(gateId, boardId, roomId, offer) {
      const result = db
        .query(
          `INSERT INTO gate_events (gate_id, board_id, room_id, claimed_at, options, subject_id,
             subject_digest, subject_preview_complete, variants, quorum)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING`,
        )
        .run(
          gateId,
          boardId,
          roomId,
          stamp(),
          offer ? JSON.stringify(offer.options) : null,
          offer?.subjectId ?? null,
          offer?.subjectDigest ?? null,
          offer?.subjectPreviewComplete == null
            ? null
            : offer.subjectPreviewComplete
              ? 1
              : 0,
          offer?.variants ? JSON.stringify(offer.variants) : null,
          offer?.quorum == null ? null : JSON.stringify(offer.quorum),
        );
      return result.changes === 1;
    },

    gateEvent(gateId) {
      const row = db
        .query<
          GateEventRow,
          [string]
        >("SELECT * FROM gate_events WHERE gate_id = ?")
        .get(gateId);
      return row ? toGateEvent(row) : null;
    },

    recordGateProse(gateId, proseEventId) {
      db.query(
        "UPDATE gate_events SET prose_event_id = ? WHERE gate_id = ?",
      ).run(proseEventId, gateId);
    },

    recordGatePosted(gateId, cardEventId) {
      db.query(
        "UPDATE gate_events SET card_event_id = ?, posted_at = ? WHERE gate_id = ?",
      ).run(cardEventId, stamp(), gateId);
    },

    claimGateOutcome(gateId) {
      const result = db
        .query(
          "UPDATE gate_events SET outcome_claimed_at = ? WHERE gate_id = ? AND outcome_claimed_at IS NULL",
        )
        .run(stamp(), gateId);
      return result.changes === 1;
    },

    releaseGateOutcome(gateId) {
      db.query(
        "UPDATE gate_events SET outcome_claimed_at = NULL WHERE gate_id = ? AND outcome_posted_at IS NULL",
      ).run(gateId);
    },

    claimGateReceipt(gateId) {
      const result = db
        .query(
          "UPDATE gate_events SET outcome_posted_at = ? WHERE gate_id = ? AND outcome_posted_at IS NULL",
        )
        .run(stamp(), gateId);
      return result.changes === 1;
    },

    settleGateEvent(gateId, decision) {
      const at = stamp();
      return (
        db
          .query(
            `UPDATE gate_events SET
               outcome_claimed_at = COALESCE(outcome_claimed_at, ?1),
               outcome_posted_at = ?1,
               settled_at = ?1,
               settled_decision = ?2
             WHERE gate_id = ?3 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(at, decision, gateId).changes === 1
      );
    },

    postedGatesAwaitingOutcome(boardId) {
      return db
        .query<GateEventRow, [string]>(
          `SELECT * FROM gate_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, gate_id`,
        )
        .all(boardId)
        .map(toGateEvent);
    },

    releaseUnfinishedOutcomes() {
      return db
        .query(
          "UPDATE gate_events SET outcome_claimed_at = NULL WHERE outcome_claimed_at IS NOT NULL AND outcome_posted_at IS NULL",
        )
        .run().changes;
    },

    moveGateEvent(gateId, was, to) {
      return (
        db
          .query(
            `UPDATE gate_events SET prose_event_id = ?, card_event_id = ?
             WHERE gate_id = ? AND prose_event_id IS ? AND card_event_id IS ?
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(
            to.proseEventId,
            to.cardEventId,
            gateId,
            was.proseEventId,
            was.cardEventId,
          ).changes === 1
      );
    },

    recordGateQuorum(gateId, quorum) {
      return db.transaction(() => {
        const row = db
          .query<
            { quorum: string | null },
            [string]
          >("SELECT quorum FROM gate_events WHERE gate_id = ? AND outcome_posted_at IS NULL")
          .get(gateId);
        if (!row) return false;
        const recorded =
          row.quorum === null ? null : (JSON.parse(row.quorum) as unknown);
        const had =
          typeof recorded === "object" &&
          recorded !== null &&
          Array.isArray((recorded as { approvals?: unknown }).approvals)
            ? (recorded as { approvals: unknown[] }).approvals.length
            : -1;
        // Never walked back by a late redelivery of an earlier approval, which carries fewer.
        if (had > quorum.approvals.length) return false;
        db.query("UPDATE gate_events SET quorum = ? WHERE gate_id = ?").run(
          JSON.stringify(quorum),
          gateId,
        );
        return true;
      })();
    },
  };
}
