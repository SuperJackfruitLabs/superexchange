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
      settledAt: null,
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
    expect(store.gateDelivery("g1")).toEqual({
      boardId: "brd_a",
      body: {},
      settledAt: null,
    });
    expect(store.unpostedGates().map((g) => g.gateId)).toEqual(["g1"]);
  });

  test("a board's room is recorded once: the first record wins", () => {
    const { store } = fresh();
    expect(store.boardRoom("brd_a")).toBeNull();
    const first = store.recordBoardRoom("brd_a", "!r1:x", "alias_a", true);
    expect(first).toMatchObject({ roomId: "!r1:x", encrypted: true });
    expect(
      store.recordBoardRoom("brd_a", "!r2:x", "alias_a", false),
    ).toMatchObject({ roomId: "!r1:x", encrypted: true });
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
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
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

describe("migration 4: encryption", () => {
  test("a room recorded before it reads as plaintext, which every such room was", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 3));
    db.exec(
      "INSERT INTO board_rooms (board_id, room_id, alias, created_at) VALUES ('brd_a', '!r:x', 'alias_a', 't0')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.boardRoom("brd_a")).toMatchObject({
      roomId: "!r:x",
      encrypted: false,
    });
  });

  test("the speaker's device is recorded once, kept across a reopen, and can be forgotten", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = openStore(dir);
    expect(store.cryptoDevice("@s:x")).toBeNull();
    expect(store.recordCryptoDevice("@s:x", "DEV1")).toBe("DEV1");
    expect(store.recordCryptoDevice("@s:x", "DEV2")).toBe("DEV1");
    store.close();
    const again = openStore(dir);
    cleanups.push(() => again.close());
    expect(again.cryptoDevice("@s:x")).toBe("DEV1");
    again.forgetCryptoDevice("@s:x");
    expect(again.cryptoDevice("@s:x")).toBeNull();
  });

  test("an event parked once waits, oldest first, across a reopen, and is claimed once", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let at = 0;
    const now = () => new Date(Date.UTC(2026, 10, 12, 10, 0, at++));
    const store = openStore(dir, { now });
    expect(store.parkPendingDecrypt("$b", "!r:x", { n: 1 }, 10)).toBe(true);
    expect(store.parkPendingDecrypt("$a", "!r:x", { n: 2 }, 10)).toBe(true);
    expect(store.parkPendingDecrypt("$b", "!r:x", { n: 3 }, 10)).toBe(false);
    store.close();
    const again = openStore(dir, { now });
    cleanups.push(() => again.close());
    expect(again.pendingDecrypts().map((r) => [r.eventId, r.event])).toEqual([
      ["$b", { n: 1 }],
      ["$a", { n: 2 }],
    ]);
    expect(again.claimPendingDecrypt("$b")).toBe(true);
    expect(again.claimPendingDecrypt("$b")).toBe(false);
    // Over the bound, the oldest go.
    again.parkPendingDecrypt("$c", "!r:x", {}, 2);
    again.parkPendingDecrypt("$d", "!r:x", {}, 2);
    expect(again.pendingDecrypts().map((r) => r.eventId)).toEqual(["$c", "$d"]);
  });
});

describe("migration 5: gates settled by the sweep", () => {
  test("a gate and a delivery recorded before it read as not settled", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 4));
    db.exec("INSERT INTO gate_deliveries VALUES ('g1', 'brd_a', 't0', '{}')");
    db.exec(
      "INSERT INTO gate_events (gate_id, board_id, room_id, card_event_id, claimed_at, posted_at) VALUES ('g1', 'brd_a', '!r:x', '$card', 't0', 't1')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.gateDelivery("g1")?.settledAt).toBeNull();
    expect(store.gateEvent("g1")).toMatchObject({
      settledAt: null,
      settledDecision: null,
    });
  });

  test("a settled delivery is never offered as unposted", () => {
    const { store } = fresh();
    store.recordGateDelivery("g1", "brd_a", {});
    store.recordGateDelivery("g2", "brd_a", {});
    expect(store.settleGateDelivery("g1")).toBe(true);
    expect(store.settleGateDelivery("g1")).toBe(false);
    expect(store.unpostedGates().map((g) => g.gateId)).toEqual(["g2"]);
    expect(store.unpostedGates("brd_a").map((g) => g.gateId)).toEqual(["g2"]);
  });

  test("the sweep claims a posted gate's receipt once, and never after the answer path's", () => {
    const { store } = fresh();
    for (const id of ["g1", "g2", "g3"]) {
      store.claimGateEvent(id, "brd_a", "!r:x");
    }
    store.recordGatePosted("g1", "$c1");
    store.recordGatePosted("g2", "$c2");
    // g3 is claimed and not posted: nothing is claimed for it.
    expect(store.settleGateEvent("g3", "approve")).toBe(false);
    expect(
      store.postedGatesAwaitingOutcome("brd_a").map((g) => g.gateId),
    ).toEqual(["g1", "g2"]);

    expect(store.settleGateEvent("g1", "reject")).toBe(true);
    expect(store.settleGateEvent("g1", "approve")).toBe(false);
    expect(store.gateEvent("g1")).toMatchObject({
      settledDecision: "reject",
      outcomeClaimedAt: expect.any(String),
      outcomePostedAt: expect.any(String),
    });

    // An answer's receipt first: the sweep claims nothing after it.
    expect(store.claimGateOutcome("g2")).toBe(true);
    expect(store.claimGateReceipt("g2")).toBe(true);
    expect(store.settleGateEvent("g2", "approve")).toBe(false);
    expect(store.gateEvent("g2")?.settledAt).toBeNull();
    expect(store.postedGatesAwaitingOutcome("brd_a")).toEqual([]);
  });
});

describe("migration 6: board questions", () => {
  const offer = {
    options: [{ id: "a", label: "A" }],
    optionsV2: [
      { id: "a", label: "A", meaning: "choose", needs_comment: false },
    ],
    freeTextMaxLength: null,
    subject: {
      id: "s1",
      digest: "d1",
      previewComplete: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    approvalRequest: true,
  };

  test("a question is delivered once, claimed once with its offer, and unposted until posted", () => {
    const { store } = fresh();
    expect(store.recordQuestionDelivery("q1", "brd_a", { x: 1 })).toBe(true);
    expect(store.recordQuestionDelivery("q1", "brd_a", { x: 2 })).toBe(false);
    expect(store.questionDelivery("q1")).toEqual({
      boardId: "brd_a",
      body: { x: 1 },
      settledAt: null,
    });
    expect(store.claimQuestionEvent("q1", "brd_a", "!r:x", offer)).toBe(true);
    expect(
      store.claimQuestionEvent("q1", "brd_a", "!other:x", {
        ...offer,
        approvalRequest: false,
      }),
    ).toBe(false);
    expect(store.questionEvent("q1")).toMatchObject({
      roomId: "!r:x",
      eventId: null,
      postedAt: null,
      offer,
    });
    expect(
      store.unpostedQuestions("brd_a").map((q) => q.elicitationId),
    ).toEqual(["q1"]);
    store.recordQuestionPosted("q1", "$e1");
    expect(store.unpostedQuestions()).toEqual([]);
    expect(store.openQuestionsInRoom("!r:x").map((q) => q.eventId)).toEqual([
      "$e1",
    ]);
  });

  test("a settled delivery is never offered as unposted", () => {
    const { store } = fresh();
    store.recordQuestionDelivery("q1", "brd_a", {});
    expect(store.settleQuestionDelivery("q1")).toBe(true);
    expect(store.settleQuestionDelivery("q1")).toBe(false);
    expect(store.unpostedQuestions()).toEqual([]);
  });

  test("a posted question has one receipt, whether the answer or the sweep claims it", () => {
    const { store } = fresh();
    for (const id of ["q1", "q2", "q3"]) {
      store.claimQuestionEvent(id, "brd_a", "!r:x", offer);
    }
    store.recordQuestionPosted("q1", "$e1");
    store.recordQuestionPosted("q2", "$e2");
    // Not posted: nothing to claim.
    expect(store.claimQuestionReceipt("q3")).toBe(false);
    expect(store.settleQuestionEvent("q3")).toBe(false);

    expect(store.claimQuestionReceipt("q1")).toBe(true);
    expect(store.claimQuestionReceipt("q1")).toBe(false);
    expect(store.settleQuestionEvent("q1")).toBe(false);
    expect(store.questionEvent("q1")?.settledAt).toBeNull();

    expect(store.settleQuestionEvent("q2")).toBe(true);
    expect(store.claimQuestionReceipt("q2")).toBe(false);
    expect(store.questionEvent("q2")?.settledAt).not.toBeNull();
    expect(store.postedQuestionsAwaitingOutcome("brd_a")).toEqual([]);
    expect(store.openQuestionsInRoom("!r:x")).toEqual([]);
  });

  test("open questions are newest first", () => {
    const { store } = fresh();
    for (const id of ["q1", "q2"]) {
      store.claimQuestionEvent(id, "brd_a", "!r:x", offer);
      store.recordQuestionPosted(id, `$${id}`);
    }
    expect(
      store.openQuestionsInRoom("!r:x").map((q) => q.elicitationId),
    ).toEqual(["q2", "q1"]);
  });
});

describe("migration 7: follow-ups and waiting cards", () => {
  test("a database at version 6 takes them, and keeps what it had", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 6));
    db.exec(
      "INSERT INTO question_deliveries (elicitation_id, board_id, received_at, body) VALUES ('q1', 'brd_a', 't0', '{}')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.questionDelivery("q1")?.boardId).toBe("brd_a");
    expect(store.recordFollowupDelivery("g1", "brd_a", { a: 1 })).toBe(true);
    expect(
      store.recordAttentionDelivery(
        { boardId: "brd_a", cardId: "c1", waitId: "w1" },
        { a: 1 },
      ),
    ).toBe(true);
  });

  const offer = {
    options: [{ id: "record_live_url", label: "Record" }],
    subjectPreviewComplete: true,
  };

  test("a follow-up is recorded once, claimed once, and has one receipt whoever claims it", () => {
    const { store } = fresh();
    expect(store.recordFollowupDelivery("g1", "brd_a", { n: 1 })).toBe(true);
    expect(store.recordFollowupDelivery("g1", "brd_a", { n: 2 })).toBe(false);
    expect(store.followupDelivery("g1")?.body).toEqual({ n: 1 });
    expect(store.unpostedFollowups("brd_a").map((f) => f.gateId)).toEqual([
      "g1",
    ]);
    expect(store.claimFollowupEvent("g1", "brd_a", "c1", "!r:x", offer)).toBe(
      true,
    );
    expect(
      store.claimFollowupEvent("g1", "brd_a", "c1", "!r:y", {
        options: [],
        subjectPreviewComplete: false,
      }),
    ).toBe(false);
    expect(store.followupEvent("g1")?.offer).toEqual(offer);
    // Claimed and not posted: no receipt to claim.
    expect(store.claimFollowupReceipt("g1")).toBe(false);
    expect(store.settleFollowupEvent("g1")).toBe(false);
    store.recordFollowupPosted("g1", "$e1");
    expect(store.unpostedFollowups()).toEqual([]);
    expect(store.claimFollowupReceipt("g1")).toBe(true);
    expect(store.claimFollowupReceipt("g1")).toBe(false);
    expect(store.settleFollowupEvent("g1")).toBe(false);
    expect(store.postedFollowupsAwaitingOutcome("brd_a")).toEqual([]);
    expect(store.settleFollowupDelivery("g1")).toBe(true);
    expect(store.settleFollowupDelivery("g1")).toBe(false);
  });

  test("a waiting card is keyed by its wait: the same card parked again is another", () => {
    const { store } = fresh();
    const a = { boardId: "brd_a", cardId: "c1", waitId: "w1" };
    const b = { ...a, waitId: "w2" };
    expect(store.recordAttentionDelivery(a, {})).toBe(true);
    expect(store.recordAttentionDelivery(a, {})).toBe(false);
    expect(store.recordAttentionDelivery(b, {})).toBe(true);
    const opts = [{ id: "archive", label: "Archive" }];
    expect(store.claimAttentionEvent(a, "!r:x", opts)).toBe(true);
    expect(store.claimAttentionEvent(a, "!r:x", [])).toBe(false);
    store.recordAttentionPosted(a, "$a");
    expect(store.unpostedAttention("brd_a").map((x) => x.waitId)).toEqual([
      "w2",
    ]);
    expect(store.attentionEvent(a)?.options).toEqual(opts);
    expect(store.settleAttentionEvent(a)).toBe(true);
    expect(store.claimAttentionReceipt(a)).toBe(false);
    expect(store.attentionEvent(a)?.settledAt).not.toBeNull();
    expect(store.attentionEvent(b)).toBeNull();
    expect(store.postedAttentionAwaitingOutcome("brd_a")).toEqual([]);
  });
});

describe("migration 8: board-room notices", () => {
  test("a database at version 7 takes them, and keeps what it had", () => {
    const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(join(dir, DATABASE_FILE), { create: true });
    migrate(db, MIGRATIONS.slice(0, 7));
    db.exec(
      "INSERT INTO followup_deliveries (gate_id, board_id, received_at, body) VALUES ('g1', 'brd_a', 't0', '{}')",
    );
    db.close();
    const store = openStore(dir);
    cleanups.push(() => store.close());
    expect(store.schemaVersion()).toBe(8);
    expect(store.followupDelivery("g1")?.boardId).toBe("brd_a");
  });

  const input = {
    noticeId: "n1",
    notice: "reminded" as const,
    boardId: "brd_a",
    cardId: "c1",
    decisionKind: "gate",
    decisionId: "g1",
    body: { cardTitle: "Ship it" },
  };

  test("a notice is recorded once, claimed once, and a claimed one is never dropped", () => {
    const { store } = fresh();
    expect(store.recordNotice(input)).toBe(true);
    expect(store.recordNotice({ ...input, body: {} })).toBe(false);
    expect(store.notice("n1")?.body).toEqual({ cardTitle: "Ship it" });
    expect(store.unpostedNotices("brd_a").map((n) => n.noticeId)).toEqual([
      "n1",
    ]);
    expect(store.claimNotice("n1", "!r:x", "$card")).toBe(true);
    expect(store.claimNotice("n1", "!r:y", null)).toBe(false);
    expect(store.dropNotice("n1")).toBe(false);
    expect(store.notice("n1")?.replyTo).toBe("$card");
    store.recordNoticePosted("n1");
    expect(store.unpostedNotices()).toEqual([]);
    expect(store.knownCardTitle("brd_a", "c1")).toBe("Ship it");
    expect(store.recordNotice({ ...input, noticeId: "n2" })).toBe(true);
    expect(store.dropNotice("n2")).toBe(true);
    expect(store.claimNotice("n2", "!r:x", null)).toBe(false);
  });

  test("an invitee's join is recorded once, and owes its re-posts until they are done", () => {
    const { store } = fresh();
    expect(store.claimEscalationInvite("brd_a", "@b:x", "!r:x")).toBe(true);
    expect(store.claimEscalationInvite("brd_a", "@b:x", "!r:x")).toBe(false);
    expect(store.recordInviteJoined("brd_a", "@nobody:x")).toBeNull();
    expect(store.recordInviteJoined("brd_a", "@b:x")?.userId).toBe("@b:x");
    expect(store.recordInviteJoined("brd_a", "@b:x")).toBeNull();
    expect(store.invitesOwingReposts(2)).toHaveLength(1);
    store.countRepostAttempt("brd_a", "@b:x");
    store.countRepostAttempt("brd_a", "@b:x");
    expect(store.invitesOwingReposts(2)).toEqual([]);
    expect(store.invitesOwingReposts(5)).toHaveLength(1);
    store.recordInviteReposted("brd_a", "@b:x");
    expect(store.invitesOwingReposts(5)).toEqual([]);
    store.forgetEscalationInvite("brd_a", "@b:x");
    expect(store.claimEscalationInvite("brd_a", "@b:x", "!r:x")).toBe(true);
  });

  test("a checks.waiting card is claimed once per arrival, found by its event, and moves only while open", () => {
    const { store } = fresh();
    const w = {
      boardId: "brd_a",
      arrivalId: "arr_1",
      cardId: "c1",
      cardTitle: "Ship it",
      stageKey: "review",
      stageName: null,
      roomId: "!r:x",
    };
    expect(store.claimChecksWaiting(w)).toBe(true);
    expect(store.claimChecksWaiting(w)).toBe(false);
    expect(store.checksWaitingByEvent("$c")).toBeNull();
    expect(store.openChecksWaiting("brd_a", "c1", "review", "!r:x")).toBeNull();
    store.recordChecksWaitingPosted("brd_a", "arr_1", "$c");
    expect(store.checksWaitingByEvent("$c")?.arrivalId).toBe("arr_1");
    expect(store.moveChecksWaiting("brd_a", "arr_1", "$other", "$d")).toBe(
      false,
    );
    expect(store.moveChecksWaiting("brd_a", "arr_1", "$c", "$d")).toBe(true);
    expect(store.checksWaitingByEvent("$c")).toBeNull();
    store.closeChecksWaiting("brd_a", "arr_1");
    expect(store.openChecksWaiting("brd_a", "c1", "review", "!r:x")).toBeNull();
    expect(store.moveChecksWaiting("brd_a", "arr_1", "$d", "$e")).toBe(false);
  });
});
