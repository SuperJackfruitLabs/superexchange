/**
 * The organization plane's client against treaty's `plane.v1` contract: every request it sends
 * reaches the operation it means and is that operation's request (`checkedFetch`), and every
 * response the contract's cases hold for the operations it calls goes through the client's real
 * parsing, its refusals in the plane's flat envelope (`flat-error.v1`) included.
 */
import { describe, expect, test } from "bun:test";
import {
  AccountsError,
  AssertionMismatch,
  assertionFailureCode,
  createAccounts,
  type Accounts,
} from "../src/board-chat/index.ts";
import {
  accepts,
  bundle,
  checkedFetch,
  contracted,
  errorCodes,
  errorStatuses,
  flatErrorCases,
  matchOperation,
  plane,
  PLANE,
  planeCases,
  urlOf,
  type PartCases,
} from "./contracts.ts";

const PLANE_URL = "http://accounts.test";
const CREDENTIAL = { id: `svc_${"0d".repeat(10)}`, secret: "plane-secret" };
const MXID = "@asha:matrix.superjackfruit.com";
const PRN = "prn_0a1b2c3d4e5f6a7b8c9d";
/** The `sub` of the token in the plane's token cases. */
const TOKEN_SUB = "prn_4f1c2a9e8b7d6c5a4e3f";

type Answer = { status: number; body: unknown };

/** A plane that answers each operation as `answers` says (404 unknown_principal otherwise). */
function fakePlane(answers: Record<string, Answer>) {
  const reached: string[] = [];
  const fetch = checkedFetch(plane, async (input, init) => {
    const op = matchOperation(plane, init?.method ?? "GET", urlOf(input));
    reached.push(op ?? "");
    const answer = (op && answers[op]) || {
      status: 404,
      body: { error: "unknown_principal" },
    };
    return Response.json(answer.body, { status: answer.status });
  });
  return { fetch, reached };
}

function accounts(answers: Record<string, Answer>): {
  client: Accounts;
  reached: string[];
} {
  const p = fakePlane(answers);
  return {
    client: createAccounts({
      url: PLANE_URL,
      credential: CREDENTIAL,
      fetch: p.fetch,
    }),
    reached: p.reached,
  };
}

function cases(operation: string, status: string): PartCases {
  const found = planeCases[operation]?.responses?.[status];
  if (!found) throw new Error(`no ${status} cases for ${operation}`);
  return found;
}

function ok(operation: string, name: string): Answer {
  const body = cases(operation, "200").valid[name];
  return { status: 200, body: contracted(plane, operation, 200, body) };
}

function invalid(operation: string, why: string): Answer {
  const found = cases(operation, "200").invalid.find((c) => c.why === why);
  if (!found) throw new Error(`no case "${why}" for ${operation}`);
  return { status: 200, body: found.body };
}

/** What a call threw, or undefined when it did not. */
async function thrown(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * Every refusal the contract has an operation answer: each code it lists, at each status that
 * carries it, and the envelope's own cases where the operation takes them. `identity_pending`
 * carries `usableAt`.
 */
function refusals(operation: string): Array<{ status: number; body: unknown }> {
  const bodies: unknown[] = [
    ...errorCodes(plane, operation).map((code) =>
      code === "identity_pending"
        ? { error: code, usableAt: "2026-11-22T10:15:00.000Z" }
        : { error: code },
    ),
    ...Object.values(flatErrorCases.valid),
  ];
  const out: Array<{ status: number; body: unknown }> = [];
  for (const status of errorStatuses(plane, operation))
    for (const body of bodies)
      if (accepts(plane, operation, status, body)) out.push({ status, body });
  return out;
}

function codeOf(body: unknown): string {
  const code =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined;
  if (typeof code !== "string") throw new Error("a flat error has a code");
  return code;
}

/** Each call this service makes, with the operations it must reach in order. */
const CALLS: Array<{
  label: string;
  operations: string[];
  answers: Record<string, Answer>;
  call: (a: Accounts) => Promise<unknown>;
}> = [
  {
    label: "serviceToken",
    operations: ["exchangeServiceToken"],
    answers: { exchangeServiceToken: ok("exchangeServiceToken", "a token") },
    call: (a) => a.serviceToken("https://superpipeline.superjackfruit.com"),
  },
  {
    label: "assert",
    operations: ["exchangeAssertion"],
    answers: { exchangeAssertion: ok("exchangeAssertion", "a token") },
    call: (a) =>
      a.assert({
        principalId: TOKEN_SUB,
        senderMxid: MXID,
        audience: "https://superpipeline.superjackfruit.com",
      }),
  },
  {
    label: "principalForMatrixId",
    operations: ["findByIdentity", "readPrincipal"],
    answers: {
      findByIdentity: ok("findByIdentity", "a person"),
      readPrincipal: ok("readPrincipal", "a person, with their role"),
    },
    call: (a) => a.principalForMatrixId(MXID),
  },
  {
    label: "principalLabel",
    operations: ["readPrincipal"],
    answers: { readPrincipal: ok("readPrincipal", "an agent") },
    call: (a) => a.principalLabel(TOKEN_SUB),
  },
  {
    label: "workspaceAdmins",
    operations: ["listPrincipals", "listIdentities"],
    answers: {
      listPrincipals: ok("listPrincipals", "a workspace"),
      listIdentities: ok("listIdentities", "two links"),
    },
    call: (a) => a.workspaceAdmins(),
  },
];

describe("plane.v1: the requests this service sends", () => {
  for (const { label, operations, answers, call } of CALLS)
    test(`${label} sends the contract's requests`, async () => {
      const { client, reached } = accounts(answers);
      await call(client);
      // checkedFetch has already held each body to its operation's request.
      expect(reached).toEqual(operations);
    });
});

describe("plane.v1: the plane's answers, read", () => {
  test("a service token", async () => {
    const { client } = accounts({
      exchangeServiceToken: ok("exchangeServiceToken", "a token"),
    });
    const token = await client.serviceToken("aud");
    expect(token.accessToken).toMatch(/^eyJ/);
    expect(token.expiresIn).toBe(300);
  });

  test("an assertion for the sender, and one for somebody else", async () => {
    const answers = { exchangeAssertion: ok("exchangeAssertion", "a token") };
    const input = { senderMxid: MXID, audience: "aud" };
    const { client } = accounts(answers);
    expect(await client.assert({ ...input, principalId: TOKEN_SUB })).toMatch(
      /^eyJ/,
    );
    const error = await thrown(client.assert({ ...input, principalId: PRN }));
    expect(error).toBeInstanceOf(AssertionMismatch);
    expect(assertionFailureCode(error)).toBe("ASSERTION_MISMATCH");
  });

  test("every identity the plane finds is a principal, named by its read", async () => {
    for (const name of Object.keys(cases("findByIdentity", "200").valid)) {
      const { client } = accounts({
        findByIdentity: ok("findByIdentity", name),
        readPrincipal: ok("readPrincipal", "a person, with their role"),
      });
      const found = await client.principalForMatrixId(MXID);
      expect(found).toMatchObject({ kind: "human", label: "Asha Rao" });
    }
  });

  test("every principal the plane reads is labelled", async () => {
    for (const name of Object.keys(cases("readPrincipal", "200").valid)) {
      const { client } = accounts({ readPrincipal: ok("readPrincipal", name) });
      expect(await client.principalLabel(TOKEN_SUB)).toBeString();
    }
  });

  test("the workspace's admins with a Matrix link, from every list", async () => {
    for (const listed of Object.keys(cases("listPrincipals", "200").valid))
      for (const links of Object.keys(cases("listIdentities", "200").valid)) {
        const { client } = accounts({
          listPrincipals: ok("listPrincipals", listed),
          listIdentities: ok("listIdentities", links),
        });
        const admins = await client.workspaceAdmins();
        expect(admins).toEqual(
          listed === "a workspace" && links === "two links" ? [MXID] : [],
        );
      }
  });
});

describe("plane.v1: the plane's refusals, in its flat envelope", () => {
  test("a refused service token or assertion throws its code", async () => {
    for (const operation of ["exchangeServiceToken", "exchangeAssertion"]) {
      const answers = refusals(operation);
      expect(answers.length).toBeGreaterThan(0);
      for (const answer of answers) {
        const { client } = accounts({ [operation]: answer });
        const error = await thrown(
          operation === "exchangeServiceToken"
            ? client.serviceToken("aud")
            : client.assert({
                principalId: TOKEN_SUB,
                senderMxid: MXID,
                audience: "aud",
              }),
        );
        expect(error).toBeInstanceOf(AccountsError);
        expect(error).toMatchObject({
          status: answer.status,
          code: codeOf(answer.body),
        });
        if (operation === "exchangeAssertion")
          expect(assertionFailureCode(error)).toBe("ASSERTION_REFUSED");
      }
    }
  });

  test("a sender the plane does not know, or whose link is still held, is nobody", async () => {
    const answers = refusals("findByIdentity");
    const notFound = answers.filter((a) => a.status === 404);
    // Every 404 is nobody; these are the two the plane names for this route.
    const codes = new Set(notFound.map((a) => codeOf(a.body)));
    expect(codes.has("identity_pending")).toBe(true);
    expect(codes.has("unknown_identity")).toBe(true);
    for (const answer of answers) {
      const { client } = accounts({ findByIdentity: answer });
      if (answer.status === 404) {
        expect(await client.principalForMatrixId(MXID)).toBeNull();
        continue;
      }
      // "Could not say" never reads as "unlinked".
      expect(await thrown(client.principalForMatrixId(MXID))).toMatchObject({
        status: answer.status,
        code: codeOf(answer.body),
      });
    }
  });

  test("only an id in treaty's principal grammar is asked about", async () => {
    const pattern: unknown = Reflect.get(
      Reflect.get(
        Reflect.get(
          Reflect.get(Object(bundle.files.get(PLANE)), "components"),
          "schemas",
        ),
        "PrincipalId",
      ),
      "pattern",
    );
    expect(pattern).toBeString();
    const grammar = new RegExp(String(pattern));
    expect(grammar.test(TOKEN_SUB)).toBe(true);
    for (const loose of [
      "prn_ana",
      `prn_${"A".repeat(20)}`,
      `prn_${"0".repeat(21)}`,
      `prn_${"0".repeat(19)}-`,
    ]) {
      expect(grammar.test(loose)).toBe(false);
      const { client, reached } = accounts({
        readPrincipal: ok(
          "readPrincipal",
          Object.keys(cases("readPrincipal", "200").valid)[0] ?? "",
        ),
      });
      expect(await client.principalLabel(loose)).toBeNull();
      expect(reached).toEqual([]);
    }
  });

  test("a principal the plane does not know has no label; any other refusal throws", async () => {
    for (const answer of refusals("readPrincipal")) {
      const { client } = accounts({ readPrincipal: answer });
      if (answer.status === 404) {
        expect(await client.principalLabel(TOKEN_SUB)).toBeNull();
        continue;
      }
      expect(await thrown(client.principalLabel(TOKEN_SUB))).toMatchObject({
        status: answer.status,
        code: codeOf(answer.body),
      });
    }
  });

  test("a refused list of principals throws; a refused list of links skips the admin", async () => {
    for (const answer of refusals("listPrincipals")) {
      const { client } = accounts({ listPrincipals: answer });
      expect(await thrown(client.workspaceAdmins())).toMatchObject({
        status: answer.status,
        code: codeOf(answer.body),
      });
    }
    for (const answer of refusals("listIdentities")) {
      const { client } = accounts({
        listPrincipals: ok("listPrincipals", "a workspace"),
        listIdentities: answer,
      });
      if (answer.status === 404) {
        expect(await client.workspaceAdmins()).toEqual([]);
        continue;
      }
      expect(await thrown(client.workspaceAdmins())).toMatchObject({
        status: answer.status,
        code: codeOf(answer.body),
      });
    }
  });
});

describe("plane.v1: bodies the client refuses", () => {
  test("a token answer without its token", async () => {
    const malformed = { status: 200, code: "malformed_response" };
    const service = accounts({
      exchangeServiceToken: invalid("exchangeServiceToken", "no access_token"),
    });
    expect(await thrown(service.client.serviceToken("aud"))).toMatchObject(
      malformed,
    );
    const assertion = accounts({
      exchangeAssertion: invalid("exchangeAssertion", "no access_token"),
    });
    expect(
      await thrown(
        assertion.client.assert({
          principalId: TOKEN_SUB,
          senderMxid: MXID,
          audience: "aud",
        }),
      ),
    ).toMatchObject(malformed);
  });

  test("a principal of a kind the plane never writes is not a person", async () => {
    const { client } = accounts({
      findByIdentity: ok("findByIdentity", "a person"),
      readPrincipal: invalid("readPrincipal", "an unknown kind"),
    });
    const found = await client.principalForMatrixId(MXID);
    expect(found?.kind).not.toBe("human");
  });

  test("a link with no Matrix id invites nobody", async () => {
    const { client } = accounts({
      listPrincipals: ok("listPrincipals", "a workspace"),
      listIdentities: invalid("listIdentities", "a link with no externalId"),
    });
    expect(await client.workspaceAdmins()).toEqual([]);
  });
});
