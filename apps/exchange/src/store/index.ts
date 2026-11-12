/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperExchange alone knows: the homeserver transactions already applied, the boards
 * an operator has pointed at it, and the gates the event relay delivered for them.
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

    close: () => db.close(),
  };
}

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
