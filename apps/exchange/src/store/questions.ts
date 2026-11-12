/**
 * The questions the relay delivered, and the ones posted: what each offered and whether its
 * receipt has been claimed.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { QuestionEvent, QuestionOfferOption, Store } from "./model.ts";

interface QuestionEventRow {
  elicitation_id: string;
  board_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  options_v2: string;
  free_text_max_length: number | null;
  subject_id: string | null;
  subject_digest: string | null;
  subject_preview_complete: number | null;
  subject_expires_at: string | null;
  approval_request: number;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toQuestionEvent = (row: QuestionEventRow): QuestionEvent => ({
  elicitationId: row.elicitation_id,
  boardId: row.board_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  offer: {
    options: JSON.parse(row.options) as Array<{ id: string; label: string }>,
    optionsV2: JSON.parse(row.options_v2) as QuestionOfferOption[],
    freeTextMaxLength: row.free_text_max_length,
    subject:
      row.subject_id === null || row.subject_digest === null
        ? null
        : {
            id: row.subject_id,
            digest: row.subject_digest,
            // Anything but a recorded 1 is not complete: an approval of it is refused.
            previewComplete: row.subject_preview_complete === 1,
            expiresAt: row.subject_expires_at,
          },
    approvalRequest: row.approval_request === 1,
  },
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

export type QuestionsQueries = Pick<
  Store,
  | "recordQuestionDelivery"
  | "questionDelivery"
  | "unpostedQuestions"
  | "settleQuestionDelivery"
  | "claimQuestionEvent"
  | "questionEvent"
  | "recordQuestionPosted"
  | "openQuestionsInRoom"
  | "claimQuestionReceipt"
  | "settleQuestionEvent"
  | "postedQuestionsAwaitingOutcome"
  | "moveQuestionEvent"
>;

export function questionsQueries(
  db: Database,
  stamp: () => string,
): QuestionsQueries {
  return {
    recordQuestionDelivery(elicitationId, boardId, body) {
      return (
        db
          .query(
            "INSERT INTO question_deliveries (elicitation_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (elicitation_id) DO NOTHING",
          )
          .run(elicitationId, boardId, stamp(), JSON.stringify(body))
          .changes === 1
      );
    },

    questionDelivery(elicitationId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM question_deliveries WHERE elicitation_id = ?")
        .get(elicitationId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    unpostedQuestions(boardId) {
      return db
        .query<
          { elicitation_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.elicitation_id, d.board_id, d.body FROM question_deliveries d
           LEFT JOIN question_events e ON e.elicitation_id = d.elicitation_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.elicitation_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          elicitationId: row.elicitation_id,
          boardId: row.board_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleQuestionDelivery(elicitationId) {
      return (
        db
          .query(
            "UPDATE question_deliveries SET settled_at = ? WHERE elicitation_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), elicitationId).changes === 1
      );
    },

    claimQuestionEvent(elicitationId, boardId, roomId, offer) {
      return (
        db
          .query(
            `INSERT INTO question_events (elicitation_id, board_id, room_id, claimed_at, options,
               options_v2, free_text_max_length, subject_id, subject_digest,
               subject_preview_complete, subject_expires_at, approval_request)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (elicitation_id) DO NOTHING`,
          )
          .run(
            elicitationId,
            boardId,
            roomId,
            stamp(),
            JSON.stringify(offer.options),
            JSON.stringify(offer.optionsV2),
            offer.freeTextMaxLength,
            offer.subject?.id ?? null,
            offer.subject?.digest ?? null,
            offer.subject ? (offer.subject.previewComplete ? 1 : 0) : null,
            offer.subject?.expiresAt ?? null,
            offer.approvalRequest ? 1 : 0,
          ).changes === 1
      );
    },

    questionEvent(elicitationId) {
      const row = db
        .query<
          QuestionEventRow,
          [string]
        >("SELECT * FROM question_events WHERE elicitation_id = ?")
        .get(elicitationId);
      return row ? toQuestionEvent(row) : null;
    },

    recordQuestionPosted(elicitationId, eventId) {
      db.query(
        "UPDATE question_events SET event_id = ?, posted_at = ? WHERE elicitation_id = ?",
      ).run(eventId, stamp(), elicitationId);
    },

    openQuestionsInRoom(roomId) {
      return db
        .query<QuestionEventRow, [string]>(
          `SELECT * FROM question_events
           WHERE room_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at DESC, rowid DESC`,
        )
        .all(roomId)
        .map(toQuestionEvent);
    },

    claimQuestionReceipt(elicitationId) {
      return (
        db
          .query(
            "UPDATE question_events SET outcome_posted_at = ? WHERE elicitation_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), elicitationId).changes === 1
      );
    },

    settleQuestionEvent(elicitationId) {
      const at = stamp();
      return (
        db
          .query(
            "UPDATE question_events SET outcome_posted_at = ?1, settled_at = ?1 WHERE elicitation_id = ?2 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(at, elicitationId).changes === 1
      );
    },

    postedQuestionsAwaitingOutcome(boardId) {
      return db
        .query<QuestionEventRow, [string]>(
          `SELECT * FROM question_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toQuestionEvent);
    },

    moveQuestionEvent(elicitationId, was, to) {
      return (
        db
          .query(
            "UPDATE question_events SET event_id = ? WHERE elicitation_id = ? AND event_id = ? AND outcome_posted_at IS NULL",
          )
          .run(to, elicitationId, was).changes === 1
      );
    },
  };
}
