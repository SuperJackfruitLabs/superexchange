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

  test("a database at schema 1 is brought up to date and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(
      "INSERT INTO gate_deliveries VALUES ('g1', 'brd_a', '2026-11-12T10:00:00.000Z', '{}')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.gateDelivery("g1")).toEqual({ boardId: "brd_a", body: {} });
    expect(store.unpostedGates().map((g) => g.gateId)).toEqual(["g1"]);
  });

  test("a board's room is recorded once: the first record wins", () => {
    const { store } = fresh();
    expect(store.boardRoom("brd_a")).toBeNull();
    const first = store.recordBoardRoom("brd_a", "!r1:x", "alias_a");
    expect(first.roomId).toBe("!r1:x");
    expect(store.recordBoardRoom("brd_a", "!r2:x", "alias_a").roomId).toBe(
      "!r1:x",
    );
    expect(store.boardRoomByRoomId("!r1:x")?.boardId).toBe("brd_a");
    expect(store.boardRoomByRoomId("!r2:x")).toBeNull();
  });

  test("a membership is recorded, then replaced by the next one", () => {
    const { store } = fresh();
    store.recordMembership("!r:x", "@ana:x", "invite");
    store.recordMembership("!r:x", "@bo:x", "join");
    expect(store.membersOf("!r:x", "join")).toEqual(["@bo:x"]);
    store.recordMembership("!r:x", "@ana:x", "join");
    expect(store.membersOf("!r:x", "join")).toEqual(["@ana:x", "@bo:x"]);
    store.recordMembership("!r:x", "@bo:x", "leave");
    expect(store.membersOf("!r:x", "join")).toEqual(["@ana:x"]);
    expect(store.membershipOf("!r:x", "@bo:x")).toBe("leave");
    expect(store.membershipOf("!r:x", "@cy:x")).toBeNull();
  });

  test("a gate is claimed once, and is unposted until its card is recorded", () => {
    const { store } = fresh();
    store.recordGateDelivery("g1", "brd_a", { n: 1 });
    store.recordGateDelivery("g2", "brd_b", { n: 2 });
    expect(store.unpostedGates().map((g) => g.gateId)).toEqual(["g1", "g2"]);
    expect(store.unpostedGates("brd_b").map((g) => g.gateId)).toEqual(["g2"]);

    expect(store.claimGateEvent("g1", "brd_a", "!r:x")).toBe(true);
    expect(store.claimGateEvent("g1", "brd_a", "!r:x")).toBe(false);
    // Claimed is not posted.
    expect(store.unpostedGates("brd_a").map((g) => g.gateId)).toEqual(["g1"]);

    store.recordGateProse("g1", "$prose");
    expect(store.gateEvent("g1")).toMatchObject({
      proseEventId: "$prose",
      cardEventId: null,
      postedAt: null,
    });
    store.recordGatePosted("g1", "$card");
    expect(store.gateEvent("g1")).toMatchObject({
      roomId: "!r:x",
      proseEventId: "$prose",
      cardEventId: "$card",
    });
    expect(store.gateEvent("g1")?.postedAt).not.toBeNull();
    expect(store.unpostedGates().map((g) => g.gateId)).toEqual(["g2"]);
    expect(store.gateEvent("g9")).toBeNull();
  });

  test("a gate claimed at schema 2 reads with no offer and no outcome after migration 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(
      "INSERT INTO gate_events (gate_id, board_id, room_id, card_event_id, claimed_at, posted_at) VALUES ('g1', 'brd_a', '!r:x', '$card', 't0', 't1')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(3);
    expect(store.gateEvent("g1")).toMatchObject({
      cardEventId: "$card",
      offer: null,
      outcomeClaimedAt: null,
      outcomePostedAt: null,
    });
  });

  test("a gate's offer is recorded with its claim, and a second claim changes nothing", () => {
    const { store } = fresh();
    const offer = {
      options: [
        {
          id: "approve_automatic",
          label: "Post automatically",
          meaning: "approve",
          needs_comment: false,
        },
        {
          id: "request_changes",
          label: "Request changes",
          meaning: "revise",
          needs_comment: true,
        },
      ],
      subjectId: "aps_1",
      subjectDigest: "sha256:1",
      subjectPreviewComplete: false,
      variants: null,
      quorum: { required: 2, from: "admins", approvals: [] },
    };
    expect(store.claimGateEvent("g1", "brd_a", "!r:x", offer)).toBe(true);
    expect(store.gateEvent("g1")?.offer).toEqual(offer);
    expect(
      store.claimGateEvent("g1", "brd_a", "!r:x", {
        ...offer,
        options: [],
        subjectId: null,
      }),
    ).toBe(false);
    expect(store.gateEvent("g1")?.offer).toEqual(offer);

    // No subject and no quorum read back as null, not as false or an empty quorum.
    const plain = {
      options: [offer.options[0]!],
      subjectId: null,
      subjectDigest: null,
      subjectPreviewComplete: null,
      variants: [
        {
          id: "v1",
          label: "Short",
          subject_id: "aps_v1",
          digest: "sha256:v1",
          preview_complete: true,
          expires_at: null,
        },
      ],
      quorum: null,
    };
    store.claimGateEvent("g2", "brd_a", "!r:x", plain);
    expect(store.gateEvent("g2")?.offer).toEqual(plain);
  });

  test("an outcome is claimed once, given back only before its receipt, and its receipt claimed once", () => {
    const { store } = fresh();
    store.claimGateEvent("g1", "brd_a", "!r:x");
    expect(store.claimGateOutcome("g1")).toBe(true);
    expect(store.claimGateOutcome("g1")).toBe(false);
    store.releaseGateOutcome("g1");
    expect(store.gateEvent("g1")?.outcomeClaimedAt).toBeNull();
    expect(store.claimGateOutcome("g1")).toBe(true);

    expect(store.claimGateReceipt("g1")).toBe(true);
    expect(store.claimGateReceipt("g1")).toBe(false);
    expect(store.gateEvent("g1")?.outcomePostedAt).not.toBeNull();
    // A gate whose receipt is claimed keeps its outcome: no later answer acts.
    store.releaseGateOutcome("g1");
    expect(store.claimGateOutcome("g1")).toBe(false);
    expect(store.claimGateOutcome("g9")).toBe(false);
  });

  test("at boot, outcomes claimed without a receipt are given back, and receipted ones kept", () => {
    const { store } = fresh();
    for (const g of ["g1", "g2", "g3"])
      store.claimGateEvent(g, "brd_a", "!r:x");
    store.claimGateOutcome("g1");
    store.claimGateOutcome("g2");
    store.claimGateReceipt("g2");
    expect(store.releaseUnfinishedOutcomes()).toBe(1);
    expect(store.gateEvent("g1")?.outcomeClaimedAt).toBeNull();
    expect(store.gateEvent("g2")?.outcomeClaimedAt).not.toBeNull();
    expect(store.gateEvent("g3")?.outcomeClaimedAt).toBeNull();
  });
});
