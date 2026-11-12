/**
 * The board-room notices (reminders, escalations, quorum progress, held approvals, checks) and
 * whom an escalation invited.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { EscalationInvite, Notice, NoticeKind, Store } from "./model.ts";

interface NoticeRow {
  notice_id: string;
  notice: string;
  board_id: string;
  card_id: string;
  decision_kind: string | null;
  decision_id: string | null;
  body: string;
  received_at: string;
  room_id: string | null;
  reply_to: string | null;
  claimed_at: string | null;
  prose_event_id: string | null;
  posted_at: string | null;
  dropped_at: string | null;
  reposted_at: string | null;
  card_moved_at: string | null;
}

const toNotice = (row: NoticeRow): Notice => ({
  noticeId: row.notice_id,
  notice: row.notice as NoticeKind,
  boardId: row.board_id,
  cardId: row.card_id,
  decisionKind: row.decision_kind,
  decisionId: row.decision_id,
  body: JSON.parse(row.body) as unknown,
  receivedAt: row.received_at,
  roomId: row.room_id,
  replyTo: row.reply_to,
  claimedAt: row.claimed_at,
  proseEventId: row.prose_event_id,
  postedAt: row.posted_at,
  droppedAt: row.dropped_at,
  repostedAt: row.reposted_at,
  cardMovedAt: row.card_moved_at,
});

interface EscalationInviteRow {
  board_id: string;
  user_id: string;
  room_id: string;
  invited_at: string;
  joined_at: string | null;
  reposted_at: string | null;
  repost_attempts: number;
}

const toEscalationInvite = (row: EscalationInviteRow): EscalationInvite => ({
  boardId: row.board_id,
  userId: row.user_id,
  roomId: row.room_id,
  invitedAt: row.invited_at,
  joinedAt: row.joined_at,
  repostedAt: row.reposted_at,
  repostAttempts: row.repost_attempts,
});

export type NoticesQueries = Pick<
  Store,
  | "recordNotice"
  | "notice"
  | "unpostedNotices"
  | "claimNotice"
  | "recordNoticeProse"
  | "recordNoticePosted"
  | "dropNotice"
  | "postedEscalations"
  | "claimNoticeRepost"
  | "releaseNoticeRepost"
  | "recordNoticeCardMoved"
  | "knownCardTitle"
  | "claimEscalationInvite"
  | "forgetEscalationInvite"
  | "recordInviteJoined"
  | "invitesOwingReposts"
  | "countRepostAttempt"
  | "recordInviteReposted"
>;

export function noticesQueries(
  db: Database,
  stamp: () => string,
): NoticesQueries {
  return {
    recordNotice(input) {
      return (
        db
          .query(
            `INSERT INTO notices (notice_id, notice, board_id, card_id, decision_kind, decision_id, body, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (notice_id) DO NOTHING`,
          )
          .run(
            input.noticeId,
            input.notice,
            input.boardId,
            input.cardId,
            input.decisionKind,
            input.decisionId,
            JSON.stringify(input.body),
            stamp(),
          ).changes === 1
      );
    },

    notice(noticeId) {
      const row = db
        .query<NoticeRow, [string]>("SELECT * FROM notices WHERE notice_id = ?")
        .get(noticeId);
      return row ? toNotice(row) : null;
    },

    unpostedNotices(boardId) {
      return db
        .query<NoticeRow, [string | null, string | null]>(
          `SELECT * FROM notices
           WHERE posted_at IS NULL AND dropped_at IS NULL AND (?1 IS NULL OR board_id = ?2)
           ORDER BY received_at, notice_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map(toNotice);
    },

    claimNotice(noticeId, roomId, replyTo) {
      return (
        db
          .query(
            `UPDATE notices SET room_id = ?, reply_to = ?, claimed_at = ?
             WHERE notice_id = ? AND claimed_at IS NULL AND dropped_at IS NULL`,
          )
          .run(roomId, replyTo, stamp(), noticeId).changes === 1
      );
    },

    recordNoticeProse(noticeId, eventId) {
      db.query("UPDATE notices SET prose_event_id = ? WHERE notice_id = ?").run(
        eventId,
        noticeId,
      );
    },

    recordNoticePosted(noticeId) {
      db.query(
        "UPDATE notices SET posted_at = ? WHERE notice_id = ? AND posted_at IS NULL",
      ).run(stamp(), noticeId);
    },

    dropNotice(noticeId) {
      return (
        db
          .query(
            "UPDATE notices SET dropped_at = ? WHERE notice_id = ? AND claimed_at IS NULL AND dropped_at IS NULL",
          )
          .run(stamp(), noticeId).changes === 1
      );
    },

    postedEscalations(boardId) {
      return db
        .query<NoticeRow, [string]>(
          `SELECT * FROM notices WHERE board_id = ? AND notice = 'escalated' AND posted_at IS NOT NULL
           ORDER BY posted_at, notice_id`,
        )
        .all(boardId)
        .map(toNotice);
    },

    claimNoticeRepost(noticeId, joinedAt) {
      return (
        db
          .query(
            `UPDATE notices SET reposted_at = ?
             WHERE notice_id = ? AND (reposted_at IS NULL OR reposted_at < ?)`,
          )
          .run(stamp(), noticeId, joinedAt).changes === 1
      );
    },

    releaseNoticeRepost(noticeId, previous) {
      db.query("UPDATE notices SET reposted_at = ? WHERE notice_id = ?").run(
        previous,
        noticeId,
      );
    },

    recordNoticeCardMoved(noticeId) {
      db.query("UPDATE notices SET card_moved_at = ? WHERE notice_id = ?").run(
        stamp(),
        noticeId,
      );
    },

    knownCardTitle(boardId, cardId) {
      const rows = db
        .query<{ body: string }, [string, string]>(
          `SELECT body FROM notices WHERE board_id = ? AND card_id = ? AND notice IN ('reminded', 'escalated')
           ORDER BY received_at DESC, notice_id DESC`,
        )
        .all(boardId, cardId);
      for (const row of rows) {
        const title = (JSON.parse(row.body) as { cardTitle?: unknown })
          .cardTitle;
        if (typeof title === "string" && title.trim() !== "")
          return title.trim();
      }
      return null;
    },

    claimEscalationInvite(boardId, userId, roomId) {
      return (
        db
          .query(
            `INSERT INTO escalation_invites (board_id, user_id, room_id, invited_at)
             VALUES (?, ?, ?, ?) ON CONFLICT (board_id, user_id) DO NOTHING`,
          )
          .run(boardId, userId, roomId, stamp()).changes === 1
      );
    },

    forgetEscalationInvite(boardId, userId) {
      db.query(
        "DELETE FROM escalation_invites WHERE board_id = ? AND user_id = ?",
      ).run(boardId, userId);
    },

    recordInviteJoined(boardId, userId) {
      const at = stamp();
      const changed = db
        .query(
          "UPDATE escalation_invites SET joined_at = ? WHERE board_id = ? AND user_id = ? AND joined_at IS NULL",
        )
        .run(at, boardId, userId).changes;
      if (changed !== 1) return null;
      const row = db
        .query<
          EscalationInviteRow,
          [string, string]
        >("SELECT * FROM escalation_invites WHERE board_id = ? AND user_id = ?")
        .get(boardId, userId);
      return row ? toEscalationInvite(row) : null;
    },

    invitesOwingReposts(maxAttempts) {
      return db
        .query<EscalationInviteRow, [number]>(
          `SELECT * FROM escalation_invites
           WHERE joined_at IS NOT NULL AND reposted_at IS NULL AND repost_attempts < ?
           ORDER BY joined_at, board_id, user_id`,
        )
        .all(maxAttempts)
        .map(toEscalationInvite);
    },

    countRepostAttempt(boardId, userId) {
      db.query(
        "UPDATE escalation_invites SET repost_attempts = repost_attempts + 1 WHERE board_id = ? AND user_id = ?",
      ).run(boardId, userId);
    },

    recordInviteReposted(boardId, userId) {
      db.query(
        "UPDATE escalation_invites SET reposted_at = ? WHERE board_id = ? AND user_id = ?",
      ).run(stamp(), boardId, userId);
    },
  };
}
