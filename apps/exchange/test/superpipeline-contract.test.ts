/**
 * SuperPipeline's client against treaty's `decisions.v1` contract: every request it sends reaches
 * the operation it means and is that operation's request (`checkedFetch`), and every response the
 * contract's cases hold for the operations it calls goes through the client's real parsing. The
 * pending items are then read with the treaty-matrix-events predicates the sweeps use, as the
 * board-room contract tests do.
 */
import { describe, expect, test } from "bun:test";
import {
  checksV2,
  isAttentionPending,
  isDeliveryPending,
  isElicitationPending,
  isGatePending,
} from "@superjackfruitlabs/treaty-matrix-events";
import {
  SuperpipelineError,
  answerAttentionAtSuperpipeline,
  answerFollowupAtSuperpipeline,
  answerQuestionAtSuperpipeline,
  createSuperpipelineReads,
  overrideCheckAtSuperpipeline,
  pullBackAtSuperpipeline,
  readWaitingChecks,
  resolveGateAtSuperpipeline,
  type ResolveResult,
  type SuperpipelineReads,
} from "../src/board-chat/index.ts";
import type { ResolveDeps } from "../src/board-chat/superpipeline.ts";
import {
  checkedFetch,
  contracted,
  decisions,
  decisionsCases,
  errorCases,
  errorStatuses,
  matchOperation,
  urlOf,
  type PartCases,
} from "./contracts.ts";

const SP_URL = "http://superpipeline.test";
const BOARD = "brd_134a0ddb6d434478";
const CARD = "card_0f3c9a2b7d4e4a11";
const GATE = "gate_5a1b2c3d4e5f6071";
const ELICITATION = "elc_2b3c4d5e6f708192";
const WAIT = "wait_3c4d5e6f70819203";
const WHO = { principalId: "prn_0123456789abcdef0123", senderMxid: "@ana:x" };

/** A board that answers every request with `answer`, recording the operation each reached. */
function board(answer: { status: number; body: unknown }) {
  const reached: string[] = [];
  const fetch = checkedFetch(decisions, async (input, init) => {
    reached.push(
      matchOperation(decisions, init?.method ?? "GET", urlOf(input)) ?? "",
    );
    return Response.json(answer.body, { status: answer.status });
  });
  return { fetch, reached };
}

/** A field of a JSON value, or undefined. */
function field(json: unknown, key: string): unknown {
  if (typeof json !== "object" || json === null) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(json, key)?.value;
  return value;
}

/** An error.v1 body's code. */
function codeOf(body: unknown): string {
  const code = field(field(body, "error"), "code");
  if (typeof code !== "string") throw new Error("an error.v1 body has a code");
  return code;
}

function personDeps(fetch: typeof globalThis.fetch): ResolveDeps {
  return { baseUrl: SP_URL, mint: async () => "person-assertion", fetch };
}

/** Each write this service makes, with the operation it must reach. */
const WRITES: Array<{
  operation: string;
  label: string;
  send: (deps: ResolveDeps) => Promise<ResolveResult>;
}> = [
  {
    operation: "resolveGate",
    label: "a plain decision",
    send: (deps) =>
      resolveGateAtSuperpipeline(
        {
          boardId: BOARD,
          gateId: GATE,
          decision: "approve",
          comment: null,
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "resolveGate",
    label: "changes requested on a bound subject",
    send: (deps) =>
      resolveGateAtSuperpipeline(
        {
          boardId: BOARD,
          gateId: GATE,
          decision: "request_changes",
          comment: "Name the second source.",
          approvalSubject: {
            id: "aps_7d6c5b4a39281706",
            digest: `sha256:${"4f".repeat(32)}`,
          },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "answerElicitation",
    label: "an option with its input, on a bound question",
    send: (deps) =>
      answerQuestionAtSuperpipeline(
        {
          boardId: BOARD,
          elicitationId: ELICITATION,
          option: "allow",
          text: "for this run",
          subject: {
            id: "aps_7d6c5b4a39281706",
            digest: `sha256:${"4f".repeat(32)}`,
          },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "answerElicitation",
    label: "free text",
    send: (deps) =>
      answerQuestionAtSuperpipeline(
        {
          boardId: BOARD,
          elicitationId: "apr_4d5e6f7081920314",
          text: "Use the staging host.",
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "setGateDelivery",
    label: "the live link",
    send: (deps) =>
      answerFollowupAtSuperpipeline(
        {
          boardId: BOARD,
          gateId: GATE,
          change: { liveUrl: "https://example.com/posts/1" },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "setGateDelivery",
    label: "automatic delivery",
    send: (deps) =>
      answerFollowupAtSuperpipeline(
        {
          boardId: BOARD,
          gateId: GATE,
          change: { mode: "automatic" },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "resumeCard",
    label: "at an earlier stage",
    send: (deps) =>
      answerAttentionAtSuperpipeline(
        {
          boardId: BOARD,
          cardId: CARD,
          waitId: WAIT,
          action: {
            kind: "resume",
            toStageKey: "research",
            comment: "Try again.",
          },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "resumeCard",
    label: "at its stage",
    send: (deps) =>
      answerAttentionAtSuperpipeline(
        {
          boardId: BOARD,
          cardId: CARD,
          waitId: WAIT,
          action: { kind: "resume", toStageKey: null, comment: "Go on." },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "archiveCard",
    label: "with a remark",
    send: (deps) =>
      answerAttentionAtSuperpipeline(
        {
          boardId: BOARD,
          cardId: CARD,
          waitId: WAIT,
          action: { kind: "archive", comment: "Not needed." },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "archiveCard",
    label: "with no remark",
    send: (deps) =>
      answerAttentionAtSuperpipeline(
        {
          boardId: BOARD,
          cardId: CARD,
          waitId: WAIT,
          action: { kind: "archive", comment: null },
          ...WHO,
        },
        deps,
      ),
  },
  {
    operation: "pullBackGate",
    label: "a reason",
    send: (deps) =>
      pullBackAtSuperpipeline(
        { boardId: BOARD, gateId: GATE, comment: "Wrong account.", ...WHO },
        deps,
      ),
  },
  {
    operation: "overrideCardCheck",
    label: "a reason",
    send: (deps) =>
      overrideCheckAtSuperpipeline(
        {
          boardId: BOARD,
          cardId: CARD,
          checkName: "ci",
          comment: "Flaky runner.",
          ...WHO,
        },
        deps,
      ),
  },
];

function cases(operation: string, status: string): PartCases {
  const found = decisionsCases[operation]?.responses?.[status];
  if (!found) throw new Error(`no ${status} cases for ${operation}`);
  return found;
}

describe("decisions.v1: the person's writes", () => {
  for (const write of new Set(WRITES.map((w) => w.operation))) {
    const sends = WRITES.filter((w) => w.operation === write);

    for (const send of sends)
      test(`${write} (${send.label}) is the contract's request`, async () => {
        const sp = board({ status: 200, body: {} });
        await send.send(personDeps(sp.fetch));
        // checkedFetch has already held the body to the operation's request.
        expect(sp.reached).toEqual([write]);
      });

    const [first] = sends;
    if (!first) continue;
    for (const [name, body] of Object.entries(cases(write, "200").valid))
      test(`${write}: 200 "${name}" is done`, async () => {
        const sp = board({
          status: 200,
          body: contracted(decisions, write, 200, body),
        });
        expect(await first.send(personDeps(sp.fetch))).toEqual({ ok: true });
      });

    for (const status of errorStatuses(decisions, write))
      for (const [name, body] of Object.entries(errorCases.valid))
        test(`${write}: ${status} "${name}" is refused with its code`, async () => {
          const sp = board({
            status,
            body: contracted(decisions, write, status, body),
          });
          const code = codeOf(body);
          expect(await first.send(personDeps(sp.fetch))).toEqual({
            ok: false,
            code,
          });
        });

    test(`${write}: a refusal in no envelope keeps its status`, async () => {
      for (const body of [{ error: "NOT_RUN_OWNER" }, "upstream error", null]) {
        const sp = board({ status: 409, body });
        expect(await first.send(personDeps(sp.fetch))).toEqual({
          ok: false,
          code: "HTTP_409",
        });
      }
    });
  }
});

/** Each read this service makes: the operation, the call, and what refuses an item it returns. */
const READS: Array<{
  operation: string;
  read: (r: SuperpipelineReads) => Promise<unknown>;
  /** The board-room predicate the sweep reads each item with, for a list. */
  item?: (v: unknown) => boolean;
}> = [
  {
    operation: "listPendingGates",
    read: (r) => r.pendingGates(BOARD),
    item: isGatePending,
  },
  {
    operation: "listPendingElicitations",
    read: (r) => r.pendingQuestions(BOARD),
    item: isElicitationPending,
  },
  {
    operation: "listPendingDeliveries",
    read: (r) => r.pendingFollowups(BOARD),
    item: isDeliveryPending,
  },
  {
    operation: "listPendingAttention",
    read: (r) => r.pendingAttention(BOARD),
    item: isAttentionPending,
  },
  { operation: "readGate", read: (r) => r.gate(BOARD, GATE) },
  { operation: "readCardChecks", read: (r) => r.cardChecks(BOARD, CARD) },
];

function reads(fetch: typeof globalThis.fetch, dropped = { n: 0 }) {
  return createSuperpipelineReads({
    baseUrl: SP_URL,
    tokens: {
      get: async () => "service-token",
      invalidate: () => void dropped.n++,
    },
    fetch,
  });
}

describe("decisions.v1: the service's reads", () => {
  for (const { operation, read, item } of READS) {
    test(`${operation} is the contract's request`, async () => {
      const sp = board({ status: 200, body: {} });
      await read(reads(sp.fetch)).catch(() => undefined);
      expect(sp.reached).toEqual([operation]);
    });

    for (const [name, body] of Object.entries(cases(operation, "200").valid))
      test(`${operation}: 200 "${name}" is read`, async () => {
        const sp = board({
          status: 200,
          body: contracted(decisions, operation, 200, body),
        });
        const got = await read(reads(sp.fetch));
        if (item) {
          expect(Array.isArray(got)).toBe(true);
          // An item with no board (`boardId: null`, which the contract allows) is not this
          // board's: the sweep counts it unreadable and posts nothing. Every other item is read.
          for (const entry of Array.isArray(got) ? got : [])
            expect(item(entry)).toBe(field(entry, "boardId") !== null);
        }
      });

    for (const status of errorStatuses(decisions, operation))
      for (const [name, body] of Object.entries(errorCases.valid))
        test(`${operation}: ${status} "${name}" throws its code`, async () => {
          const sp = board({
            status,
            body: contracted(decisions, operation, status, body),
          });
          const dropped = { n: 0 };
          const error = await read(reads(sp.fetch, dropped)).catch(
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(SuperpipelineError);
          expect(error).toMatchObject({
            status,
            code: codeOf(body),
          });
          // A 401 drops the held token, so the next read asks for another.
          expect(dropped.n).toBe(status === 401 ? 1 : 0);
        });
  }
});

function gate(name: string): unknown {
  return cases("readGate", "200").valid[name];
}

async function readGate(body: unknown) {
  return reads(board({ status: 200, body }).fetch).gate(BOARD, GATE);
}

async function readChecks(body: unknown) {
  return reads(board({ status: 200, body }).fetch).cardChecks(BOARD, CARD);
}

function invalid(operation: string, why: string): unknown {
  const found = cases(operation, "200").invalid.find((c) => c.why === why);
  if (!found) throw new Error(`no case "${why}" for ${operation}`);
  return found.body;
}

function readsOf(body: unknown): SuperpipelineReads {
  return reads(board({ status: 200, body }).fetch);
}

/** What a read threw, or undefined when it did not. */
async function thrown(read: Promise<unknown>): Promise<unknown> {
  return read.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("decisions.v1: what the client reads, from the board's own words", () => {
  test("a gate's status, decision, decider, release and pull-back", async () => {
    expect(await readGate(gate("pending"))).toMatchObject({
      status: "pending",
      decision: null,
    });
    expect(await readGate(gate("resolved with delivery"))).toMatchObject({
      status: "resolved",
      decision: "approve_manual",
      decidedBy: "prn_0123456789abcdef0123",
    });
    // A cancelled gate is no decision: the sweep leaves it alone.
    expect(await readGate(gate("cancelled"))).toMatchObject({
      status: "cancelled",
      decision: null,
    });
    const pulled = await readGate(gate("held then pulled back"));
    expect(pulled.status).toBe("resolved");
    expect(pulled.pulledBackBy).not.toBeNull();
  });

  test("a card's checks: open ones are offered, none reached is null", async () => {
    const checks = cases("readCardChecks", "200").valid;
    const open = await readChecks(checks["open"]);
    expect(open).toMatchObject({ stageKey: "review", status: "open" });
    expect(checksV2(open?.checks)).toHaveLength(2);
    expect(
      await readChecks(checks["never reached a stage with checks"]),
    ).toBeNull();
  });
});

describe("decisions.v1: bodies the client refuses", () => {
  test("a pending list without its array is never read as empty", async () => {
    const malformed = { code: "malformed_response" };
    expect(
      await thrown(
        readsOf(invalid("listPendingGates", "no gates list")).pendingGates(
          BOARD,
        ),
      ),
    ).toMatchObject(malformed);
    // The other lists, without theirs.
    const other = readsOf({ gates: [] });
    for (const read of [
      other.pendingQuestions(BOARD),
      other.pendingFollowups(BOARD),
      other.pendingAttention(BOARD),
    ])
      expect(await thrown(read)).toMatchObject(malformed);
  });

  test("a pending item the board-room contract refuses is refused by the sweep's predicate", async () => {
    for (const [operation, why, list, item] of [
      [
        "listPendingGates",
        "an item that is not a gate.pending body",
        "gates",
        isGatePending,
      ],
      [
        "listPendingElicitations",
        "an item with no elicitationId",
        "elicitations",
        isElicitationPending,
      ],
      // The follow-up and waiting-card predicates check the shape only; their options and
      // reasons are read later, when the card is built, so they are not held to these cases here.
    ] as const) {
      const listed = field(invalid(operation, why), list);
      const items: unknown[] = Array.isArray(listed) ? listed : [];
      expect(items.length).toBeGreaterThan(0);
      expect(items.some((entry) => !item(entry))).toBe(true);
    }
  });

  test("a read with no gate is refused", async () => {
    expect(
      await thrown(readsOf(invalid("readGate", "no gate")).gate(BOARD, GATE)),
    ).toMatchObject({ code: "malformed_response" });
  });

  test("checks in a status the board never writes are not offered", async () => {
    const lines: string[] = [];
    const offered = await readWaitingChecks(
      {
        checks: readsOf(
          invalid("readCardChecks", "a check status the board never writes"),
        ),
        log: (line) => lines.push(line),
      },
      { boardId: BOARD, cardId: CARD, stageKey: "review" },
    );
    expect(offered).toBeNull();
  });
});
