/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperExchange alone knows: the homeserver transactions already applied, the boards
 * an operator has pointed at it, the gates the event relay delivered for them, each board's room
 * and who is in it (and whether it is end-to-end encrypted), which gates have been posted there
 * with what they offered, whether a person's answer to each has acted and its receipt been
 * posted, which gates the board says were decided elsewhere and settled here, the questions the
 * relay delivered and the ones posted (with what they offered, and whether their receipt has been
 * claimed), the delivery follow-ups and waiting cards likewise, the board-room notices (reminders,
 * escalations and whom they invited, quorum progress, held approvals, checks) and the checks.waiting
 * cards, the speaker's encryption device, and encrypted events still waiting for their key.
 *
 * The lowest layer beside config: it knows tables, not Matrix and not boards' rules. Its schema
 * is a list of migrations applied in order at boot and recorded in `PRAGMA user_version`; a
 * database written by a newer build is refused rather than guessed at.
 *
 * `migrations.ts` holds the schema and `model.ts` the shapes and the `Store` interface. Each table
 * group's reads and writes are a module of their own (boards, rooms, gates, questions, follow-ups,
 * attention, notices, checks, crypto), given the one database and clock; `openStore` composes
 * them. Callers import from this file only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { attentionQueries } from "./attention.ts";
import { boardsQueries } from "./boards.ts";
import { checksQueries } from "./checks.ts";
import { cryptoQueries } from "./crypto.ts";
import { followupsQueries } from "./followups.ts";
import { gatesQueries } from "./gates.ts";
import { migrate, userVersion } from "./migrations.ts";
import { StoreError, type Store } from "./model.ts";
import { noticesQueries } from "./notices.ts";
import { questionsQueries } from "./questions.ts";
import { roomsQueries } from "./rooms.ts";

export { MIGRATIONS, migrate } from "./migrations.ts";
export {
  StoreError,
  type Board,
  type BoardInput,
  type BoardRoom,
  type PendingDecrypt,
  type GateOfferOption,
  type GateOfferVariant,
  type GateOffer,
  type GateEvent,
  type QuestionOfferOption,
  type QuestionOfferSubject,
  type QuestionOffer,
  type QuestionEvent,
  type CardOfferOption,
  type FollowupOffer,
  type FollowupEvent,
  type UnpostedFollowup,
  type WaitKey,
  type AttentionEvent,
  type UnpostedAttention,
  type UnpostedQuestion,
  type UnpostedGate,
  type NoticeKind,
  type NoticeInput,
  type Notice,
  type EscalationInvite,
  type ChecksWaiting,
  type Store,
} from "./model.ts";

/** The database's file name inside the data directory. */
export const DATABASE_FILE = "superexchange.sqlite";

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
        ? String(error.code)
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
  return {
    schemaVersion: () => userVersion(db),
    ...boardsQueries(db, stamp),
    ...roomsQueries(db, stamp),
    ...gatesQueries(db, stamp),
    ...questionsQueries(db, stamp),
    ...followupsQueries(db, stamp),
    ...attentionQueries(db, stamp),
    ...noticesQueries(db, stamp),
    ...checksQueries(db, stamp),
    ...cryptoQueries(db, stamp),
    close: () => db.close(),
  };
}
