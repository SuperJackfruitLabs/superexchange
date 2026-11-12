/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperExchange alone knows: the homeserver transactions already applied, the boards
 * an operator has pointed at it, the gates the event relay delivered for them, each board's room
 * and who is in it (and whether it is end-to-end encrypted), which gates have been posted there
 * with what they offered, whether a person's answer to each has acted and its receipt been
 * posted, the speaker's encryption device, and encrypted events still waiting for their key.
 *
 * The lowest layer beside config: it knows tables, not Matrix and not boards' rules. Its schema
 * is a list of migrations applied in order at boot and recorded in `PRAGMA user_version`; a
 * database written by a newer build is refused rather than guessed at.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The database's file name inside the data directory. */
export const DATABASE_FILE = "superexchange.sqlite";

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
];

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** A board an operator has pointed at this service. */
export interface Board {
  boardId: string;
  spTenantId: string;
  orgId: string;
  /** Matrix user ids invited to the board's room. */
  invitees: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardInput {
  boardId: string;
  spTenantId: string;
  orgId: string;
  invitees: string[];
}

/** A board's room, as recorded when it was made. */
export interface BoardRoom {
  boardId: string;
  roomId: string;
  /** The alias's localpart. */
  alias: string;
  /**
   * Whether the room is end-to-end encrypted. Fixed when the room is recorded: Matrix has no way
   * to turn encryption off, and a plaintext room is never turned on here.
   */
  encrypted: boolean;
  createdAt: string;
}

/** An encrypted event waiting for the key that opens it, exactly as it was delivered. */
export interface PendingDecrypt {
  eventId: string;
  roomId: string;
  /** The event as the homeserver delivered it, still encrypted. */
  event: Record<string, unknown>;
  firstSeenAt: string;
}

/** One option a gate offered when it was posted. */
export interface GateOfferOption {
  id: string;
  label: string;
  /** What choosing it does: `approve`, `reject`, `revise`, … */
  meaning: string;
  needs_comment: boolean;
}

/** One variant a choice gate offered when it was posted. */
export interface GateOfferVariant {
  id: string;
  label: string;
  subject_id: string;
  digest: string;
  preview_complete: boolean;
  expires_at: string | null;
}

/**
 * What a gate offered when it was posted: an answer is checked against this, never against a
 * fixed list. Recorded with the claim, before anything is sent.
 */
export interface GateOffer {
  options: GateOfferOption[];
  /** The subject a subject-bound gate approves; null when it is bound to none. */
  subjectId: string | null;
  subjectDigest: string | null;
  /** Whether the subject's preview was shown in full; null when there is no subject. */
  subjectPreviewComplete: boolean | null;
  /** A choice gate's variants; null when it is not a choice. */
  variants: GateOfferVariant[] | null;
  /** A quorum gate's quorum as posted (treaty's `quorumV2`), or null when one approval passes it. */
  quorum: unknown;
}

/**
 * A gate's claim on its room. A row with no `postedAt` is claimed and not yet (fully) posted:
 * the prose may already have landed (`proseEventId`), the card not.
 */
export interface GateEvent {
  gateId: string;
  boardId: string;
  roomId: string;
  cardEventId: string | null;
  proseEventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  /** What the gate offered; null for a gate claimed before offers were recorded. */
  offer: GateOffer | null;
  /** Set while, or once, a person's answer is being carried to the board. */
  outcomeClaimedAt: string | null;
  /** Set once the receipt is claimed for posting: a gate gets one receipt. */
  outcomePostedAt: string | null;
}

/** A delivered gate with no posted event yet. */
export interface UnpostedGate {
  gateId: string;
  boardId: string;
  body: unknown;
}

export interface Store {
  /** The schema version the database is at. */
  schemaVersion(): number;
  /**
   * Record a homeserver transaction id. True the first time, false for a repeat: the caller
   * applies a transaction only when this says it is new.
   */
  claimTransaction(txnId: string): boolean;
  /** Create or replace a board's settings, and enable it. */
  upsertBoard(input: BoardInput): Board;
  /** Disable a board; null when it was never opted in. */
  disableBoard(boardId: string): Board | null;
  getBoard(boardId: string): Board | null;
  listBoards(): Board[];
  /** Record a delivered gate. True when new, false when this gate id was already recorded. */
  recordGateDelivery(gateId: string, boardId: string, body: unknown): boolean;
  /** The recorded body of a gate, or null. */
  gateDelivery(gateId: string): { boardId: string; body: unknown } | null;
  /**
   * Delivered gates not yet posted, oldest first: never claimed, or claimed and unfinished. Only
   * `boardId`'s when it is given.
   */
  unpostedGates(boardId?: string): UnpostedGate[];

  /**
   * Record a board's room, and whether it is encrypted. The first record wins: returns the room
   * on record afterwards, which is this one unless another was recorded first.
   */
  recordBoardRoom(
    boardId: string,
    roomId: string,
    alias: string,
    encrypted: boolean,
  ): BoardRoom;
  boardRoom(boardId: string): BoardRoom | null;
  /** The board room a Matrix room is, or null. */
  boardRoomByRoomId(roomId: string): BoardRoom | null;

  /** Record a user's membership of a room (`join`, `invite`, `leave`, `ban`, `knock`). */
  recordMembership(roomId: string, userId: string, membership: string): void;
  /** The users recorded with a membership of `membership` in a room. */
  membersOf(roomId: string, membership: string): string[];
  /** A user's recorded membership of a room, or null. */
  membershipOf(roomId: string, userId: string): string | null;

  /**
   * Claim a gate's post into a room, recording what it offers. True when this call made the
   * claim; false when the gate was already claimed (posted or not), and the offer is not changed.
   */
  claimGateEvent(
    gateId: string,
    boardId: string,
    roomId: string,
    offer?: GateOffer,
  ): boolean;
  gateEvent(gateId: string): GateEvent | null;
  /** Record the prose message's event id, once it has landed. */
  recordGateProse(gateId: string, proseEventId: string): void;
  /** Record the card's event id, and that the gate is posted. */
  recordGatePosted(gateId: string, cardEventId: string): void;
  /**
   * Claim a gate's outcome before a person's answer is carried to the board. True when this call
   * made the claim; false when another answer holds it, or already acted.
   */
  claimGateOutcome(gateId: string): boolean;
  /** Give an outcome claim back, so the next answer may act: the board did not take this one. */
  releaseGateOutcome(gateId: string): void;
  /** Claim the gate's receipt before it is sent. True once per gate. */
  claimGateReceipt(gateId: string): boolean;
  /**
   * Give back every outcome claim whose receipt was never claimed: at boot, nothing is carrying
   * an answer, so such a claim was left by a run that stopped mid-answer. Answers how many.
   */
  releaseUnfinishedOutcomes(): number;

  /** The encryption device recorded for a user, or null. */
  cryptoDevice(userId: string): string | null;
  /**
   * Record a user's encryption device. The first record wins: answers the device on record
   * afterwards, which is this one unless another was recorded first.
   */
  recordCryptoDevice(userId: string, deviceId: string): string;
  /** Forget a user's device: its keys are gone, and the next start takes a new one. */
  forgetCryptoDevice(userId: string): void;

  /**
   * Park an encrypted event until its key arrives. True when newly parked, false when it was
   * already waiting. Over `max` waiting, the oldest are dropped.
   */
  parkPendingDecrypt(
    eventId: string,
    roomId: string,
    event: Record<string, unknown>,
    max: number,
  ): boolean;
  /** Every parked event, oldest first. */
  pendingDecrypts(): PendingDecrypt[];
  /**
   * Take a parked event off the list. True only for the caller that removed it, so two retries
   * never act on the same event twice.
   */
  claimPendingDecrypt(eventId: string): boolean;
  close(): void;
}

interface BoardRow {
  board_id: string;
  sp_tenant_id: string;
  org_id: string;
  invitees: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Open (creating if need be) the store in `dataDir`, and bring its schema up to date. */
export function openStore(
  dataDir: string,
  { now = () => new Date() }: { now?: () => Date } = {},
): Store {
  let db: Database;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, DATABASE_FILE), {
      create: true,
      strict: true,
    });
  } catch (error) {
    // The path is a setting's value, and fs and SQLite errors quote it: only the code is kept.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    throw new StoreError(
      `the store cannot be opened in SUPEREXCHANGE_DATA_DIR (${code})`,
    );
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const stamp = () => now().toISOString();
  const toBoard = (row: BoardRow): Board => ({
    boardId: row.board_id,
    spTenantId: row.sp_tenant_id,
    orgId: row.org_id,
    invitees: JSON.parse(row.invitees) as string[],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const getBoard = (boardId: string): Board | null => {
    const row = db
      .query<BoardRow, [string]>("SELECT * FROM boards WHERE board_id = ?")
      .get(boardId);
    return row ? toBoard(row) : null;
  };

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
    schemaVersion: () => userVersion(db),

    claimTransaction(txnId) {
      const result = db
        .query(
          "INSERT INTO as_transactions (txn_id, received_at) VALUES (?, ?) ON CONFLICT (txn_id) DO NOTHING",
        )
        .run(txnId, stamp());
      return result.changes === 1;
    },

    upsertBoard(input) {
      const at = stamp();
      db.query(
        `INSERT INTO boards (board_id, sp_tenant_id, org_id, invitees, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (board_id) DO UPDATE SET
           sp_tenant_id = excluded.sp_tenant_id,
           org_id = excluded.org_id,
           invitees = excluded.invitees,
           enabled = 1,
           updated_at = excluded.updated_at`,
      ).run(
        input.boardId,
        input.spTenantId,
        input.orgId,
        JSON.stringify(input.invitees),
        at,
        at,
      );
      return getBoard(input.boardId) as Board;
    },

    disableBoard(boardId) {
      db.query(
        "UPDATE boards SET enabled = 0, updated_at = ? WHERE board_id = ?",
      ).run(stamp(), boardId);
      return getBoard(boardId);
    },

    getBoard,

    listBoards() {
      return db
        .query<BoardRow, []>("SELECT * FROM boards ORDER BY board_id")
        .all()
        .map(toBoard);
    },

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
          { board_id: string; body: string },
          [string]
        >("SELECT board_id, body FROM gate_deliveries WHERE gate_id = ?")
        .get(gateId);
      return row
        ? { boardId: row.board_id, body: JSON.parse(row.body) as unknown }
        : null;
    },

    unpostedGates(boardId) {
      const rows = db
        .query<
          { gate_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.gate_id, d.board_id, d.body FROM gate_deliveries d
           LEFT JOIN gate_events e ON e.gate_id = d.gate_id
           WHERE e.posted_at IS NULL AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.gate_id`,
        )
        .all(boardId ?? null, boardId ?? null);
      return rows.map((row) => ({
        gateId: row.gate_id,
        boardId: row.board_id,
        body: JSON.parse(row.body) as unknown,
      }));
    },

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

    releaseUnfinishedOutcomes() {
      return db
        .query(
          "UPDATE gate_events SET outcome_claimed_at = NULL WHERE outcome_claimed_at IS NOT NULL AND outcome_posted_at IS NULL",
        )
        .run().changes;
    },

    cryptoDevice(userId) {
      const row = db
        .query<
          { device_id: string },
          [string]
        >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
        .get(userId);
      return row?.device_id ?? null;
    },

    recordCryptoDevice(userId, deviceId) {
      db.query(
        "INSERT INTO crypto_devices (user_id, device_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
      ).run(userId, deviceId, stamp());
      return (
        db
          .query<
            { device_id: string },
            [string]
          >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
          .get(userId)?.device_id ?? deviceId
      );
    },

    forgetCryptoDevice(userId) {
      db.query("DELETE FROM crypto_devices WHERE user_id = ?").run(userId);
    },

    parkPendingDecrypt(eventId, roomId, event, max) {
      return db.transaction(() => {
        const inserted = db
          .query(
            "INSERT INTO pending_decrypts (event_id, room_id, event, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
          )
          .run(eventId, roomId, JSON.stringify(event), stamp()).changes;
        if (inserted !== 1) return false;
        db.query(
          `DELETE FROM pending_decrypts WHERE event_id IN (
             SELECT event_id FROM pending_decrypts
             ORDER BY first_seen_at DESC, event_id DESC LIMIT -1 OFFSET ?
           )`,
        ).run(max);
        return true;
      })();
    },

    pendingDecrypts() {
      return db
        .query<
          {
            event_id: string;
            room_id: string;
            event: string;
            first_seen_at: string;
          },
          []
        >("SELECT * FROM pending_decrypts ORDER BY first_seen_at, event_id")
        .all()
        .map((row) => ({
          eventId: row.event_id,
          roomId: row.room_id,
          event: JSON.parse(row.event) as Record<string, unknown>,
          firstSeenAt: row.first_seen_at,
        }));
    },

    claimPendingDecrypt(eventId) {
      return (
        db.query("DELETE FROM pending_decrypts WHERE event_id = ?").run(eventId)
          .changes === 1
      );
    },

    close: () => db.close(),
  };
}

interface BoardRoomRow {
  board_id: string;
  room_id: string;
  alias: string;
  encrypted: number;
  created_at: string;
}

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
});

const toBoardRoom = (row: BoardRoomRow): BoardRoom => ({
  boardId: row.board_id,
  roomId: row.room_id,
  alias: row.alias,
  encrypted: row.encrypted === 1,
  createdAt: row.created_at,
});

function userVersion(db: Database): number {
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
