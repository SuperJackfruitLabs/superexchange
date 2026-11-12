/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperExchange alone knows: the homeserver transactions already applied, the boards
 * an operator has pointed at it, the gates the event relay delivered for them, each board's room
 * and who is in it (and whether it is end-to-end encrypted), which gates have been posted there
 * with what they offered, whether a person's answer to each has acted and its receipt been
 * posted, which gates the board says were decided elsewhere and settled here, the questions the
 * relay delivered and the ones posted (with what they offered, and whether their receipt has been
 * claimed), the speaker's encryption device, and encrypted events still waiting for their key.
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
  /** Set when the sweep claimed the receipt for a gate the board says was decided elsewhere. */
  settledAt: string | null;
  /** The decision the board gave for it then. */
  settledDecision: string | null;
}

/** One option of a question as it was posted, in question.v2's shape (treaty's `QuestionOptionV2`). */
export interface QuestionOfferOption {
  id: string;
  label: string;
  meaning: string;
  needs_comment: boolean;
  input?: {
    kind: "text" | "url";
    label?: string;
    required: boolean;
    max_length: number;
  };
  scope?: string;
  requires?: string;
}

/** The subject a question is bound to, as it was posted. */
export interface QuestionOfferSubject {
  id: string;
  digest: string;
  /** False refuses an approving answer: the card could not show all of it. */
  previewComplete: boolean;
  /** ISO; null when the subject named no expiry that could be read. */
  expiresAt: string | null;
}

/**
 * What a question offered when it was posted. Recorded with the claim, before anything is sent:
 * a structured answer is judged against `optionsV2`, a typed reply matched against `options`.
 */
export interface QuestionOffer {
  /** `{id, label}` in the order the prose numbers them: what a typed reply is matched against. */
  options: Array<{ id: string; label: string }>;
  /** What question.v2 carried. */
  optionsV2: QuestionOfferOption[];
  /** A question with no options is answered by typing, at most this many characters; else null. */
  freeTextMaxLength: number | null;
  subject: QuestionOfferSubject | null;
  /** A SuperToolkit approval request: answered by a person only, never allowed unbound. */
  approvalRequest: boolean;
}

/** A question's claim on its room. No `eventId` means claimed and not yet posted. */
export interface QuestionEvent {
  elicitationId: string;
  boardId: string;
  roomId: string;
  /** The prose message: the one event an answer may reference. */
  eventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  offer: QuestionOffer;
  /** Set once the receipt is claimed: a question gets one. */
  outcomePostedAt: string | null;
  /** Set when the sweep claimed the receipt for a question the board no longer waits on. */
  settledAt: string | null;
}

/** A delivered question with no posted event yet. */
export interface UnpostedQuestion {
  elicitationId: string;
  boardId: string;
  body: unknown;
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
  /** The recorded body of a gate, and when it was settled (null while it is not), or null. */
  gateDelivery(
    gateId: string,
  ): { boardId: string; body: unknown; settledAt: string | null } | null;
  /**
   * Delivered gates not yet posted and not settled, oldest first: never claimed, or claimed and
   * unfinished. Only `boardId`'s when it is given.
   */
  unpostedGates(boardId?: string): UnpostedGate[];
  /**
   * Mark a delivered gate settled: the board says it was decided, so it is never posted after
   * this. True when this call settled it.
   */
  settleGateDelivery(gateId: string): boolean;

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
   * The sweep's claim on a posted gate's receipt, for a gate the board says was decided
   * elsewhere: true once per gate, and false once any receipt is claimed (the answer path's
   * included) or the gate is not posted. It takes the outcome too, so a later answer in chat is
   * told it was already decided. Called only between answers (board chat's queue), so an
   * outcome claim still held then is one the board refused as not pending, and is settled here.
   */
  settleGateEvent(gateId: string, decision: string): boolean;
  /** A board's posted gates whose receipt is not claimed, oldest first. */
  postedGatesAwaitingOutcome(boardId: string): GateEvent[];
  /**
   * Give back every outcome claim whose receipt was never claimed: at boot, nothing is carrying
   * an answer, so such a claim was left by a run that stopped mid-answer. Answers how many.
   */
  releaseUnfinishedOutcomes(): number;

  /** Record a delivered question. True when new, false when this id was already recorded. */
  recordQuestionDelivery(
    elicitationId: string,
    boardId: string,
    body: unknown,
  ): boolean;
  /** The recorded body of a question, and when it was settled (null while it is not), or null. */
  questionDelivery(
    elicitationId: string,
  ): { boardId: string; body: unknown; settledAt: string | null } | null;
  /** Delivered questions not yet posted and not settled, oldest first; only `boardId`'s if given. */
  unpostedQuestions(boardId?: string): UnpostedQuestion[];
  /** Mark a delivered question settled: never posted after this. True when this call did. */
  settleQuestionDelivery(elicitationId: string): boolean;
  /**
   * Claim a question's post into a room, recording what it offers. True when this call made the
   * claim; false when it was already claimed, and the offer is not changed.
   */
  claimQuestionEvent(
    elicitationId: string,
    boardId: string,
    roomId: string,
    offer: QuestionOffer,
  ): boolean;
  questionEvent(elicitationId: string): QuestionEvent | null;
  /** Record the question's message, and that it is posted. */
  recordQuestionPosted(elicitationId: string, eventId: string): void;
  /** A room's posted questions whose receipt is not claimed, newest first. */
  openQuestionsInRoom(roomId: string): QuestionEvent[];
  /** Claim a posted question's receipt before it is sent. True once per question. */
  claimQuestionReceipt(elicitationId: string): boolean;
  /**
   * The sweep's claim on a posted question's receipt, for one the board no longer waits on: true
   * once, false once any receipt is claimed or the question is not posted.
   */
  settleQuestionEvent(elicitationId: string): boolean;
  /** A board's posted questions whose receipt is not claimed, oldest first. */
  postedQuestionsAwaitingOutcome(boardId: string): QuestionEvent[];

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
