import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_FILE, MIGRATIONS, type Store } from "../src/store/index.ts";
import { tempStore } from "./helpers.ts";

/**
 * A characterization of the whole store, written against the store as it stood before it was
 * split into modules: one scripted run through every method on a fixed clock, every result it
 * returned, and every row it left behind, compared with `fixtures/store-trace.json`. A change to
 * what any method returns or writes, to the order it reads the clock in, or to the schema fails
 * here. Regenerate the fixture only for a change meant to alter the store, with
 * `STORE_TRACE_WRITE=1 bun test apps/exchange/test/store-trace.test.ts`, and say why in the
 * commit.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "store-trace.json");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Trace {
  methods: string[];
  migrationsSha256: string;
  schema: Array<{ type: string; name: string; sql: string | null }>;
  calls: Array<[string, unknown]>;
  rows: Record<string, unknown[]>;
}

const key = { boardId: "brd_1", cardId: "crd_1", waitId: "wt_1" };
const otherKey = { boardId: "brd_1", cardId: "crd_2", waitId: "wt_2" };
const gateOffer = {
  options: [
    {
      id: "approve",
      label: "Approve",
      meaning: "approve",
      needs_comment: false,
    },
  ],
  subjectId: "sub_1",
  subjectDigest: "sha256:abc",
  subjectPreviewComplete: true,
  variants: null,
  quorum: { required: 2 },
};
const questionOffer = {
  options: [{ id: "yes", label: "Yes" }],
  optionsV2: [
    { id: "yes", label: "Yes", meaning: "yes", needs_comment: false },
  ],
  freeTextMaxLength: 200,
  subject: null,
  approvalRequest: false,
};
const followupOffer = {
  options: [{ id: "retry", label: "Retry" }],
  subjectPreviewComplete: null,
};
const options = [
  {
    id: "done",
    label: "Done",
    input: { kind: "text" as const, required: false, max_length: 50 },
  },
];

function run(store: Store): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = [];
  const rec = (name: string, value: unknown) => {
    calls.push([name, value ?? null]);
  };
  const s = store;

  rec("schemaVersion", s.schemaVersion());
  rec("claimTransaction", s.claimTransaction("txn_1"));
  rec("claimTransaction", s.claimTransaction("txn_1"));

  const board = { boardId: "brd_1", spTenantId: "t_1", orgId: "org_1" };
  rec("upsertBoard", s.upsertBoard({ ...board, invitees: ["@a:hs"] }));
  rec("upsertBoard", s.upsertBoard({ ...board, invitees: ["@a:hs", "@b:hs"] }));
  rec(
    "upsertBoard",
    s.upsertBoard({ ...board, boardId: "brd_2", invitees: [] }),
  );
  rec("disableBoard", s.disableBoard("brd_2"));
  rec("disableBoard", s.disableBoard("brd_none"));
  rec("getBoard", s.getBoard("brd_1"));
  rec("getBoard", s.getBoard("brd_none"));
  rec("listBoards", s.listBoards());

  rec("recordGateDelivery", s.recordGateDelivery("gte_1", "brd_1", { n: 1 }));
  rec("recordGateDelivery", s.recordGateDelivery("gte_1", "brd_1", { n: 2 }));
  rec("recordGateDelivery", s.recordGateDelivery("gte_2", "brd_2", { n: 3 }));
  rec("recordGateDelivery", s.recordGateDelivery("gte_3", "brd_1", { n: 4 }));
  rec("gateDelivery", s.gateDelivery("gte_1"));
  rec("gateDelivery", s.gateDelivery("gte_none"));
  rec("unpostedGates", s.unpostedGates());
  rec("unpostedGates", s.unpostedGates("brd_1"));
  rec("settleGateDelivery", s.settleGateDelivery("gte_3"));
  rec("settleGateDelivery", s.settleGateDelivery("gte_3"));

  rec("recordBoardRoom", s.recordBoardRoom("brd_1", "!r1:hs", "#b1:hs", true));
  rec("recordBoardRoom", s.recordBoardRoom("brd_1", "!r9:hs", "#b9:hs", false));
  rec("boardRoom", s.boardRoom("brd_1"));
  rec("boardRoom", s.boardRoom("brd_none"));
  rec("boardRoomByRoomId", s.boardRoomByRoomId("!r1:hs"));
  rec("boardRoomByRoomId", s.boardRoomByRoomId("!none:hs"));

  rec("recordMembership", s.recordMembership("!r1:hs", "@b:hs", "invite"));
  rec("recordMembership", s.recordMembership("!r1:hs", "@a:hs", "join"));
  rec("recordMembership", s.recordMembership("!r1:hs", "@b:hs", "join"));
  rec("membersOf", s.membersOf("!r1:hs", "join"));
  rec("membershipOf", s.membershipOf("!r1:hs", "@b:hs"));
  rec("membershipOf", s.membershipOf("!r1:hs", "@c:hs"));

  rec(
    "claimGateEvent",
    s.claimGateEvent("gte_1", "brd_1", "!r1:hs", gateOffer),
  );
  rec(
    "claimGateEvent",
    s.claimGateEvent("gte_1", "brd_1", "!r1:hs", gateOffer),
  );
  rec("claimGateEvent", s.claimGateEvent("gte_2", "brd_1", "!r1:hs"));
  rec("gateEvent", s.gateEvent("gte_1"));
  rec("recordGateProse", s.recordGateProse("gte_1", "$p1"));
  rec("recordGatePosted", s.recordGatePosted("gte_1", "$c1"));
  rec("recordGatePosted", s.recordGatePosted("gte_2", "$c2"));
  rec("unpostedGates", s.unpostedGates());
  rec("postedGatesAwaitingOutcome", s.postedGatesAwaitingOutcome("brd_1"));
  rec(
    "moveGateEvent",
    s.moveGateEvent(
      "gte_1",
      { proseEventId: "$p1", cardEventId: "$c1" },
      { proseEventId: "$p1b", cardEventId: "$c1b" },
    ),
  );
  rec(
    "moveGateEvent",
    s.moveGateEvent(
      "gte_1",
      { proseEventId: "$p1", cardEventId: "$c1" },
      { proseEventId: "$p1c", cardEventId: "$c1c" },
    ),
  );
  rec("recordGateQuorum", s.recordGateQuorum("gte_1", { approvals: ["@a"] }));
  rec(
    "recordGateQuorum",
    s.recordGateQuorum("gte_1", { approvals: ["@a", "@b"] }),
  );
  rec("recordGateQuorum", s.recordGateQuorum("gte_1", { approvals: [] }));
  rec("recordGateQuorum", s.recordGateQuorum("gte_none", { approvals: [] }));
  rec("claimGateOutcome", s.claimGateOutcome("gte_1"));
  rec("claimGateOutcome", s.claimGateOutcome("gte_1"));
  rec("releaseGateOutcome", s.releaseGateOutcome("gte_1"));
  rec("claimGateOutcome", s.claimGateOutcome("gte_1"));
  rec("claimGateOutcome", s.claimGateOutcome("gte_2"));
  rec("releaseUnfinishedOutcomes", s.releaseUnfinishedOutcomes());
  rec("claimGateReceipt", s.claimGateReceipt("gte_1"));
  rec("claimGateReceipt", s.claimGateReceipt("gte_1"));
  rec("settleGateEvent", s.settleGateEvent("gte_2", "approve"));
  rec("settleGateEvent", s.settleGateEvent("gte_2", "reject"));
  rec("gateEvent", s.gateEvent("gte_2"));
  rec("gateEvent", s.gateEvent("gte_none"));
  rec("postedGatesAwaitingOutcome", s.postedGatesAwaitingOutcome("brd_1"));
  rec("claimLinkHint", s.claimLinkHint("@a:hs", "!r1:hs", "2026-01-01"));
  rec("claimLinkHint", s.claimLinkHint("@a:hs", "!r1:hs", "2026-01-01"));
  rec("claimLinkHint", s.claimLinkHint("@a:hs", "!r1:hs", "2026-01-02"));

  rec(
    "recordQuestionDelivery",
    s.recordQuestionDelivery("elc_1", "brd_1", { q: 1 }),
  );
  rec(
    "recordQuestionDelivery",
    s.recordQuestionDelivery("elc_1", "brd_1", { q: 2 }),
  );
  rec(
    "recordQuestionDelivery",
    s.recordQuestionDelivery("elc_2", "brd_1", { q: 3 }),
  );
  rec(
    "recordQuestionDelivery",
    s.recordQuestionDelivery("elc_3", "brd_2", { q: 4 }),
  );
  rec("questionDelivery", s.questionDelivery("elc_1"));
  rec("questionDelivery", s.questionDelivery("elc_none"));
  rec("unpostedQuestions", s.unpostedQuestions());
  rec("unpostedQuestions", s.unpostedQuestions("brd_2"));
  rec("settleQuestionDelivery", s.settleQuestionDelivery("elc_3"));
  rec("settleQuestionDelivery", s.settleQuestionDelivery("elc_3"));
  rec(
    "claimQuestionEvent",
    s.claimQuestionEvent("elc_1", "brd_1", "!r1:hs", questionOffer),
  );
  rec(
    "claimQuestionEvent",
    s.claimQuestionEvent("elc_1", "brd_1", "!r1:hs", questionOffer),
  );
  rec(
    "claimQuestionEvent",
    s.claimQuestionEvent("elc_2", "brd_1", "!r1:hs", questionOffer),
  );
  rec("recordQuestionPosted", s.recordQuestionPosted("elc_1", "$q1"));
  rec("recordQuestionPosted", s.recordQuestionPosted("elc_2", "$q2"));
  rec("questionEvent", s.questionEvent("elc_1"));
  rec("questionEvent", s.questionEvent("elc_none"));
  rec("openQuestionsInRoom", s.openQuestionsInRoom("!r1:hs"));
  rec("moveQuestionEvent", s.moveQuestionEvent("elc_1", "$q1", "$q1b"));
  rec("moveQuestionEvent", s.moveQuestionEvent("elc_1", "$q1", "$q1c"));
  rec("claimQuestionReceipt", s.claimQuestionReceipt("elc_1"));
  rec("claimQuestionReceipt", s.claimQuestionReceipt("elc_1"));
  rec("moveQuestionEvent", s.moveQuestionEvent("elc_1", "$q1b", "$q1d"));
  rec("settleQuestionEvent", s.settleQuestionEvent("elc_2"));
  rec("settleQuestionEvent", s.settleQuestionEvent("elc_2"));
  rec(
    "postedQuestionsAwaitingOutcome",
    s.postedQuestionsAwaitingOutcome("brd_1"),
  );
  rec("unpostedQuestions", s.unpostedQuestions());

  rec(
    "recordFollowupDelivery",
    s.recordFollowupDelivery("gte_f1", "brd_1", { f: 1 }),
  );
  rec(
    "recordFollowupDelivery",
    s.recordFollowupDelivery("gte_f1", "brd_1", { f: 2 }),
  );
  rec(
    "recordFollowupDelivery",
    s.recordFollowupDelivery("gte_f2", "brd_1", { f: 3 }),
  );
  rec(
    "recordFollowupDelivery",
    s.recordFollowupDelivery("gte_f3", "brd_2", { f: 4 }),
  );
  rec("followupDelivery", s.followupDelivery("gte_f1"));
  rec("followupDelivery", s.followupDelivery("gte_none"));
  rec("unpostedFollowups", s.unpostedFollowups());
  rec("unpostedFollowups", s.unpostedFollowups("brd_2"));
  rec("settleFollowupDelivery", s.settleFollowupDelivery("gte_f3"));
  rec("settleFollowupDelivery", s.settleFollowupDelivery("gte_f3"));
  rec(
    "claimFollowupEvent",
    s.claimFollowupEvent("gte_f1", "brd_1", "crd_1", "!r1:hs", followupOffer),
  );
  rec(
    "claimFollowupEvent",
    s.claimFollowupEvent("gte_f1", "brd_1", "crd_1", "!r1:hs", followupOffer),
  );
  rec(
    "claimFollowupEvent",
    s.claimFollowupEvent("gte_f2", "brd_1", "crd_2", "!r1:hs", followupOffer),
  );
  rec("recordFollowupPosted", s.recordFollowupPosted("gte_f1", "$f1"));
  rec("recordFollowupPosted", s.recordFollowupPosted("gte_f2", "$f2"));
  rec("followupEvent", s.followupEvent("gte_f1"));
  rec("followupEvent", s.followupEvent("gte_none"));
  rec("moveFollowupEvent", s.moveFollowupEvent("gte_f1", "$f1", "$f1b"));
  rec("moveFollowupEvent", s.moveFollowupEvent("gte_f1", "$f1", "$f1c"));
  rec("claimFollowupReceipt", s.claimFollowupReceipt("gte_f1"));
  rec("claimFollowupReceipt", s.claimFollowupReceipt("gte_f1"));
  rec("moveFollowupEvent", s.moveFollowupEvent("gte_f1", "$f1b", "$f1d"));
  rec("settleFollowupEvent", s.settleFollowupEvent("gte_f2"));
  rec("settleFollowupEvent", s.settleFollowupEvent("gte_f2"));
  rec(
    "postedFollowupsAwaitingOutcome",
    s.postedFollowupsAwaitingOutcome("brd_1"),
  );
  rec("unpostedFollowups", s.unpostedFollowups());

  rec("recordAttentionDelivery", s.recordAttentionDelivery(key, { w: 1 }));
  rec("recordAttentionDelivery", s.recordAttentionDelivery(key, { w: 2 }));
  rec("recordAttentionDelivery", s.recordAttentionDelivery(otherKey, { w: 3 }));
  rec(
    "recordAttentionDelivery",
    s.recordAttentionDelivery({ ...otherKey, boardId: "brd_2" }, { w: 4 }),
  );
  rec("attentionDelivery", s.attentionDelivery(key));
  rec("attentionDelivery", s.attentionDelivery({ ...key, waitId: "none" }));
  rec("unpostedAttention", s.unpostedAttention());
  rec("unpostedAttention", s.unpostedAttention("brd_2"));
  rec(
    "settleAttentionDelivery",
    s.settleAttentionDelivery({ ...otherKey, boardId: "brd_2" }),
  );
  rec(
    "settleAttentionDelivery",
    s.settleAttentionDelivery({ ...otherKey, boardId: "brd_2" }),
  );
  rec("claimAttentionEvent", s.claimAttentionEvent(key, "!r1:hs", options));
  rec("claimAttentionEvent", s.claimAttentionEvent(key, "!r1:hs", options));
  rec("claimAttentionEvent", s.claimAttentionEvent(otherKey, "!r1:hs", []));
  rec("recordAttentionPosted", s.recordAttentionPosted(key, "$w1"));
  rec("recordAttentionPosted", s.recordAttentionPosted(otherKey, "$w2"));
  rec("attentionEvent", s.attentionEvent(key));
  rec("attentionEvent", s.attentionEvent({ ...key, waitId: "none" }));
  rec("moveAttentionEvent", s.moveAttentionEvent(key, "$w1", "$w1b"));
  rec("moveAttentionEvent", s.moveAttentionEvent(key, "$w1", "$w1c"));
  rec("claimAttentionReceipt", s.claimAttentionReceipt(key));
  rec("claimAttentionReceipt", s.claimAttentionReceipt(key));
  rec("moveAttentionEvent", s.moveAttentionEvent(key, "$w1b", "$w1d"));
  rec("settleAttentionEvent", s.settleAttentionEvent(otherKey));
  rec("settleAttentionEvent", s.settleAttentionEvent(otherKey));
  rec(
    "postedAttentionAwaitingOutcome",
    s.postedAttentionAwaitingOutcome("brd_1"),
  );
  rec("unpostedAttention", s.unpostedAttention());

  const notice = {
    noticeId: "ntc_1",
    notice: "escalated" as const,
    boardId: "brd_1",
    cardId: "crd_1",
    decisionKind: "gate",
    decisionId: "gte_1",
    body: { cardTitle: " Ship it " },
  };
  rec("recordNotice", s.recordNotice(notice));
  rec("recordNotice", s.recordNotice(notice));
  rec(
    "recordNotice",
    s.recordNotice({
      ...notice,
      noticeId: "ntc_2",
      notice: "reminded",
      decisionKind: null,
      decisionId: null,
      body: {},
    }),
  );
  rec(
    "recordNotice",
    s.recordNotice({ ...notice, noticeId: "ntc_3", boardId: "brd_2" }),
  );
  rec("notice", s.notice("ntc_1"));
  rec("notice", s.notice("ntc_none"));
  rec("unpostedNotices", s.unpostedNotices());
  rec("unpostedNotices", s.unpostedNotices("brd_2"));
  rec("claimNotice", s.claimNotice("ntc_1", "!r1:hs", "$c1b"));
  rec("claimNotice", s.claimNotice("ntc_1", "!r1:hs", null));
  rec("claimNotice", s.claimNotice("ntc_2", "!r1:hs", null));
  rec("recordNoticeProse", s.recordNoticeProse("ntc_1", "$n1"));
  rec("recordNoticePosted", s.recordNoticePosted("ntc_1"));
  rec("dropNotice", s.dropNotice("ntc_2"));
  rec("dropNotice", s.dropNotice("ntc_3"));
  rec("dropNotice", s.dropNotice("ntc_3"));
  rec("recordNotice", s.recordNotice({ ...notice, noticeId: "ntc_9" }));
  rec("claimNotice", s.claimNotice("ntc_9", "!r1:hs", null));
  rec("recordNoticePosted", s.recordNoticePosted("ntc_9"));
  rec("postedEscalations", s.postedEscalations("brd_1"));
  rec(
    "claimNoticeRepost",
    s.claimNoticeRepost("ntc_1", "2026-01-01T00:00:00.000Z"),
  );
  rec(
    "claimNoticeRepost",
    s.claimNoticeRepost("ntc_1", "2026-01-01T00:00:00.000Z"),
  );
  rec("releaseNoticeRepost", s.releaseNoticeRepost("ntc_1", null));
  rec(
    "claimNoticeRepost",
    s.claimNoticeRepost("ntc_1", "2026-01-02T00:00:00.000Z"),
  );
  rec("recordNoticeCardMoved", s.recordNoticeCardMoved("ntc_1"));
  rec("notice", s.notice("ntc_1"));
  rec("knownCardTitle", s.knownCardTitle("brd_1", "crd_1"));
  rec("knownCardTitle", s.knownCardTitle("brd_1", "crd_none"));
  rec("unpostedNotices", s.unpostedNotices());

  rec(
    "claimEscalationInvite",
    s.claimEscalationInvite("brd_1", "@c:hs", "!r1:hs"),
  );
  rec(
    "claimEscalationInvite",
    s.claimEscalationInvite("brd_1", "@c:hs", "!r1:hs"),
  );
  rec(
    "claimEscalationInvite",
    s.claimEscalationInvite("brd_1", "@d:hs", "!r1:hs"),
  );
  rec(
    "claimEscalationInvite",
    s.claimEscalationInvite("brd_1", "@e:hs", "!r1:hs"),
  );
  rec("forgetEscalationInvite", s.forgetEscalationInvite("brd_1", "@e:hs"));
  rec("recordInviteJoined", s.recordInviteJoined("brd_1", "@c:hs"));
  rec("recordInviteJoined", s.recordInviteJoined("brd_1", "@c:hs"));
  rec("recordInviteJoined", s.recordInviteJoined("brd_1", "@d:hs"));
  rec("recordInviteJoined", s.recordInviteJoined("brd_1", "@none:hs"));
  rec("invitesOwingReposts", s.invitesOwingReposts(2));
  rec("countRepostAttempt", s.countRepostAttempt("brd_1", "@c:hs"));
  rec("countRepostAttempt", s.countRepostAttempt("brd_1", "@c:hs"));
  rec("invitesOwingReposts", s.invitesOwingReposts(2));
  rec("recordInviteReposted", s.recordInviteReposted("brd_1", "@d:hs"));
  rec("invitesOwingReposts", s.invitesOwingReposts(5));

  const checks = {
    boardId: "brd_1",
    arrivalId: "arr_1",
    cardId: "crd_1",
    cardTitle: "Ship it",
    stageKey: "review",
    stageName: "Review",
    roomId: "!r1:hs",
  };
  rec("claimChecksWaiting", s.claimChecksWaiting(checks));
  rec("claimChecksWaiting", s.claimChecksWaiting(checks));
  rec(
    "claimChecksWaiting",
    s.claimChecksWaiting({ ...checks, arrivalId: "arr_2", stageName: null }),
  );
  rec("checksWaiting", s.checksWaiting("brd_1", "arr_1"));
  rec("checksWaiting", s.checksWaiting("brd_1", "arr_none"));
  rec(
    "recordChecksWaitingPosted",
    s.recordChecksWaitingPosted("brd_1", "arr_1", "$k1"),
  );
  rec("checksWaitingByEvent", s.checksWaitingByEvent("$k1"));
  rec("checksWaitingByEvent", s.checksWaitingByEvent("$none"));
  rec(
    "openChecksWaiting",
    s.openChecksWaiting("brd_1", "crd_1", "review", "!r1:hs"),
  );
  rec(
    "openChecksWaiting",
    s.openChecksWaiting("brd_1", "crd_1", "other", "!r1:hs"),
  );
  rec(
    "moveChecksWaiting",
    s.moveChecksWaiting("brd_1", "arr_1", "$k1", "$k1b"),
  );
  rec(
    "moveChecksWaiting",
    s.moveChecksWaiting("brd_1", "arr_1", "$k1", "$k1c"),
  );
  rec("closeChecksWaiting", s.closeChecksWaiting("brd_1", "arr_1"));
  rec(
    "moveChecksWaiting",
    s.moveChecksWaiting("brd_1", "arr_1", "$k1b", "$k1d"),
  );
  rec(
    "openChecksWaiting",
    s.openChecksWaiting("brd_1", "crd_1", "review", "!r1:hs"),
  );

  rec("cryptoDevice", s.cryptoDevice("@bot:hs"));
  rec("recordCryptoDevice", s.recordCryptoDevice("@bot:hs", "DEV1"));
  rec("recordCryptoDevice", s.recordCryptoDevice("@bot:hs", "DEV2"));
  rec("cryptoDevice", s.cryptoDevice("@bot:hs"));
  rec("forgetCryptoDevice", s.forgetCryptoDevice("@bot:hs"));
  rec("cryptoDevice", s.cryptoDevice("@bot:hs"));
  rec("recordCryptoDevice", s.recordCryptoDevice("@bot:hs", "DEV3"));

  const event = { type: "m.room.encrypted", content: { ciphertext: "x" } };
  rec("parkPendingDecrypt", s.parkPendingDecrypt("$e1", "!r1:hs", event, 2));
  rec("parkPendingDecrypt", s.parkPendingDecrypt("$e1", "!r1:hs", event, 2));
  rec("parkPendingDecrypt", s.parkPendingDecrypt("$e2", "!r1:hs", event, 2));
  rec("parkPendingDecrypt", s.parkPendingDecrypt("$e3", "!r1:hs", event, 2));
  rec("pendingDecrypts", s.pendingDecrypts());
  rec("claimPendingDecrypt", s.claimPendingDecrypt("$e2"));
  rec("claimPendingDecrypt", s.claimPendingDecrypt("$e2"));
  rec("pendingDecrypts", s.pendingDecrypts());
  rec("schemaVersion", s.schemaVersion());
  return calls;
}

function trace(): Trace {
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const { dir, store, cleanup } = tempStore(() => new Date((t += 1000)));
  cleanups.push(cleanup);
  const calls = run(store);
  const db = new Database(join(dir, DATABASE_FILE), { readonly: true });
  cleanups.push(() => db.close());
  const schema = db
    .query<
      { type: string; name: string; sql: string | null },
      []
    >("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all();
  const rows: Record<string, unknown[]> = {};
  for (const { name } of schema.filter((x) => x.type === "table"))
    rows[name] = db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return {
    methods: Object.keys(store).toSorted(),
    migrationsSha256: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(MIGRATIONS))
      .digest("hex"),
    schema,
    calls,
    rows,
  };
}

describe("the store, as a whole", () => {
  test("does and leaves exactly what it did before the split", () => {
    const got = trace();
    if (process.env.STORE_TRACE_WRITE === "1")
      writeFileSync(FIXTURE, JSON.stringify(got, null, 1) + "\n");
    expect(existsSync(FIXTURE)).toBe(true);
    const want: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(JSON.parse(JSON.stringify(got))).toEqual(want);
  });

  test("the run calls every method the store has", () => {
    const got = trace();
    const called = new Set(got.calls.map(([name]) => name));
    expect(got.methods.filter((m) => !called.has(m))).toEqual(["close"]);
  });
});
