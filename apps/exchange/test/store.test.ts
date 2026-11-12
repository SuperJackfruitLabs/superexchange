import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILE,
  MIGRATIONS,
  StoreError,
  migrate,
  openStore,
} from "../src/store/index.ts";
import { tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
function fresh(now?: () => Date) {
  const t = tempStore(now);
  cleanups.push(t.cleanup);
  return t;
}

describe("the store", () => {
  test("opens in WAL mode at the latest schema version", () => {
    const { dir, store } = fresh();
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const db = new Database(join(dir, DATABASE_FILE), { readonly: true });
    const mode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    db.close();
    expect(mode?.journal_mode).toBe("wal");
  });

  test("reopening applies nothing twice and keeps the rows", () => {
    const { dir, store } = fresh();
    expect(store.claimTransaction("t1")).toBe(true);
    store.close();
    const again = openStore(dir);
    cleanups.push(() => again.close());
    expect(again.schemaVersion()).toBe(MIGRATIONS.length);
    expect(again.claimTransaction("t1")).toBe(false);
  });

  test("migrations run in order and record their version", () => {
    const db = new Database(":memory:");
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(2);
    // A third migration added later is applied on its own.
    migrate(db, [
      "CREATE TABLE a (x)",
      "CREATE TABLE b (y)",
      "CREATE TABLE c (z)",
    ]);
    expect(
      db
        .query<
          { n: number },
          []
        >("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get()?.n,
    ).toBe(3);
    db.close();
  });

  test("a failed migration leaves the version where it was", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, ["CREATE TABLE a (x)", "NOT SQL"])).toThrow();
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(1);
    db.close();
  });

  test("refuses a database written by a newer build", () => {
    const db = new Database(":memory:");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(StoreError);
    db.close();
  });

  test("an error opening it names the setting, never the path", () => {
    // A directory under a plain file cannot be made, even by root.
    const parent = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const file = join(parent, "a-file");
    writeFileSync(file, "");
    const dir = join(file, "data");
    let message = "";
    try {
      openStore(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      message = (error as Error).message;
    }
    expect(message).toContain("SUPEREXCHANGE_DATA_DIR");
    expect(message).not.toContain(parent);
  });

  test("a transaction id is claimed once", () => {
    const { store } = fresh();
    expect(store.claimTransaction("txn-a")).toBe(true);
    expect(store.claimTransaction("txn-a")).toBe(false);
    expect(store.claimTransaction("txn-b")).toBe(true);
  });

  test("a board is opted in, replaced, disabled and re-enabled", () => {
    let clock = new Date("2026-11-12T10:00:00.000Z");
    const { store } = fresh(() => clock);
    const first = store.upsertBoard({
      boardId: "brd_a",
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: ["@ana:example.test"],
    });
    expect(first).toEqual({
      boardId: "brd_a",
      spTenantId: "tnt_1",
      orgId: "org_1",
      invitees: ["@ana:example.test"],
      enabled: true,
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    });

    clock = new Date("2026-11-12T11:00:00.000Z");
    expect(store.disableBoard("brd_a")?.enabled).toBe(false);
    expect(store.disableBoard("brd_missing")).toBeNull();

    clock = new Date("2026-11-12T12:00:00.000Z");
    const again = store.upsertBoard({
      boardId: "brd_a",
      spTenantId: "tnt_2",
      orgId: "org_1",
      invitees: [],
    });
    expect(again.enabled).toBe(true);
    expect(again.spTenantId).toBe("tnt_2");
    expect(again.createdAt).toBe("2026-11-12T10:00:00.000Z");
    expect(again.updatedAt).toBe("2026-11-12T12:00:00.000Z");
    expect(store.listBoards().map((b) => b.boardId)).toEqual(["brd_a"]);
  });

  test("a gate delivery is recorded once per gate id", () => {
    const { store } = fresh();
    expect(store.recordGateDelivery("g1", "brd_a", { n: 1 })).toBe(true);
    expect(store.recordGateDelivery("g1", "brd_a", { n: 2 })).toBe(false);
    expect(store.gateDelivery("g1")).toEqual({
      boardId: "brd_a",
      body: { n: 1 },
    });
    expect(store.gateDelivery("g2")).toBeNull();
  });
});
