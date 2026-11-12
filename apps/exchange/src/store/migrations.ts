/**
 * The store's schema: a list of migrations applied in order at boot and recorded in
 * `PRAGMA user_version`; a database written by a newer build is refused rather than guessed at.
 */
import type { Database } from "bun:sqlite";
import { StoreError } from "./model.ts";

/**
 * The schema, one entry per version. Append only: a shipped entry is never edited, because a
 * database that already applied it would never see the change.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE as_transactions (
     txn_id TEXT PRIMARY KEY,
     received_at TEXT NOT NULL
   );
   CREATE TABLE boards (
     board_id TEXT PRIMARY KEY,
     sp_tenant_id TEXT NOT NULL,
     org_id TEXT NOT NULL,
     invitees TEXT NOT NULL,
     enabled INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE gate_deliveries (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL
   );
   CREATE INDEX gate_deliveries_board ON gate_deliveries (board_id);`,
  `CREATE TABLE board_rooms (
     board_id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL UNIQUE,
     alias TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE room_members (
     room_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     membership TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (room_id, user_id)
   );
   CREATE TABLE gate_events (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     card_event_id TEXT,
     prose_event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT
   );
   CREATE INDEX gate_events_room ON gate_events (room_id);`,
  `ALTER TABLE gate_events ADD COLUMN options TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_id TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_digest TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_preview_complete INTEGER;
   ALTER TABLE gate_events ADD COLUMN variants TEXT;
   ALTER TABLE gate_events ADD COLUMN quorum TEXT;
   ALTER TABLE gate_events ADD COLUMN outcome_claimed_at TEXT;
   ALTER TABLE gate_events ADD COLUMN outcome_posted_at TEXT;`,
  // Every room recorded before this migration was made without encryption, so 0 is the truth
  // for them, not a guess.
  `ALTER TABLE board_rooms ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE crypto_devices (
     user_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE pending_decrypts (
     event_id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
     event TEXT NOT NULL,
     first_seen_at TEXT NOT NULL
   );
   CREATE INDEX pending_decrypts_seen ON pending_decrypts (first_seen_at);`,
  // The sweep: a gate the board says was decided elsewhere. A posted gate's receipt is claimed
  // with the outcome columns of migration 3, so the answer path and the sweep share one claim;
  // these record that the sweep made it and with what. A delivery settled before it was ever
  // posted is never posted.
  `ALTER TABLE gate_events ADD COLUMN settled_at TEXT;
   ALTER TABLE gate_events ADD COLUMN settled_decision TEXT;
   ALTER TABLE gate_deliveries ADD COLUMN settled_at TEXT;`,
  // Board questions (elicitation.pending): what the relay or the sweep delivered, and each one
  // posted into its room with what it offered, so an answer is judged against what was shown. A
  // question is one event (its prose, the v1 card inside it); `outcome_posted_at` is its one
  // receipt, claimed by the answer path or by the sweep when the board no longer waits on it.
  `CREATE TABLE question_deliveries (
     elicitation_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT
   );
   CREATE INDEX question_deliveries_board ON question_deliveries (board_id);
   CREATE TABLE question_events (
     elicitation_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     options_v2 TEXT NOT NULL,
     free_text_max_length INTEGER,
     subject_id TEXT,
     subject_digest TEXT,
     subject_preview_complete INTEGER,
     subject_expires_at TEXT,
     approval_request INTEGER NOT NULL,
     outcome_posted_at TEXT,
     settled_at TEXT
   );
   CREATE INDEX question_events_room ON question_events (room_id);
   CREATE INDEX question_events_board ON question_events (board_id);`,
  // Delivery follow-ups (delivery.pending, keyed by the gate they follow) and waiting cards
  // (attention.pending, keyed by board, card and wait): what the relay or the sweep delivered, and
  // each one posted into its room with what it offered, so an answer is judged against what was
  // shown. Each is one event; `outcome_posted_at` is its one receipt, claimed by the answer path or
  // by the sweep when the board no longer lists it.
  `CREATE TABLE followup_deliveries (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT
   );
   CREATE INDEX followup_deliveries_board ON followup_deliveries (board_id);
   CREATE TABLE followup_events (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     subject_preview_complete INTEGER,
     outcome_posted_at TEXT,
     settled_at TEXT
   );
   CREATE INDEX followup_events_board ON followup_events (board_id);
   CREATE TABLE attention_deliveries (
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     wait_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT,
     PRIMARY KEY (board_id, card_id, wait_id)
   );
   CREATE TABLE attention_events (
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     wait_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     outcome_posted_at TEXT,
     settled_at TEXT,
     PRIMARY KEY (board_id, card_id, wait_id)
   );`,
  // Board-room notices: a decision's reminder or escalation, a quorum gate's approval, a held
  // approval released or pulled back, a check failed or overridden. Each is recorded once under
  // its key (what makes it the same notice when it is delivered again), claimed with the room and
  // the card it replies to before anything is sent, and posted once. One that has nothing true to
  // say (its card never posted here, or already settled) is dropped, and never posted after.
  // An escalation's invites are recorded once per board and person, so somebody who leaves is not
  // invited back, and their join owes the open escalations one re-post. A check set's escalation
  // posts one checks.waiting card (keyed by its arrival), which an override must reference.
  `CREATE TABLE notices (
     notice_id TEXT PRIMARY KEY,
     notice TEXT NOT NULL,
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     decision_kind TEXT,
     decision_id TEXT,
     body TEXT NOT NULL,
     received_at TEXT NOT NULL,
     room_id TEXT,
     reply_to TEXT,
     claimed_at TEXT,
     prose_event_id TEXT,
     posted_at TEXT,
     dropped_at TEXT,
     reposted_at TEXT,
     card_moved_at TEXT
   );
   CREATE INDEX notices_board ON notices (board_id);
   CREATE TABLE escalation_invites (
     board_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     invited_at TEXT NOT NULL,
     joined_at TEXT,
     reposted_at TEXT,
     repost_attempts INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (board_id, user_id)
   );
   CREATE TABLE checks_waiting (
     board_id TEXT NOT NULL,
     arrival_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     card_title TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     stage_name TEXT,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     closed_at TEXT,
     PRIMARY KEY (board_id, arrival_id)
   );
   CREATE INDEX checks_waiting_event ON checks_waiting (event_id);`,
  // 9. Board chat tells a person linked to nobody how to link, at most once a day in a room.
  `CREATE TABLE link_hints (
     sender TEXT NOT NULL,
     room_id TEXT NOT NULL,
     day TEXT NOT NULL,
     PRIMARY KEY (sender, room_id, day)
   );`,
];

export function userVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

/** Apply every migration the database has not seen, each in its own transaction. */
export function migrate(
  db: Database,
  migrations: readonly string[] = MIGRATIONS,
): void {
  const at = userVersion(db);
  if (at > migrations.length) {
    throw new StoreError(
      `the database is at schema version ${at}, newer than this build's ${migrations.length}`,
    );
  }
  for (let version = at + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1] as string;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
  }
}
