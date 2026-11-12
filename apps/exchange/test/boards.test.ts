import { afterEach, describe, expect, test } from "bun:test";
import { createBoardsHandler } from "../src/routes/boards.ts";
import {
  OPERATOR_TOKEN,
  OPERATOR_TOKEN_SHA256,
  captureLog,
  tempStore,
} from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const { log, lines } = captureLog();
  const handle = createBoardsHandler({
    operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    store: t.store,
    log,
  });
  return { handle, store: t.store, lines };
}

const auth = { authorization: `Bearer ${OPERATOR_TOKEN}` };
const SETTINGS = {
  spTenantId: "tnt_1",
  orgId: "org_1",
  invitees: ["@ana:example.test", "@ben:example.test:8448"],
};

function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = auth,
) {
  return new Request(`http://exchange${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}

describe("the board opt-in API", () => {
  test("a board is opted in, listed, disabled and re-enabled", async () => {
    const { handle } = setup();
    const put = await handle(req("PUT", "/v1/boards/brd_7c1f", SETTINGS));
    expect(put.status).toBe(200);
    const { board } = (await put.json()) as { board: Record<string, unknown> };
    expect(board).toMatchObject({
      boardId: "brd_7c1f",
      enabled: true,
      ...SETTINGS,
    });

    const list = await handle(req("GET", "/v1/boards"));
    expect(((await list.json()) as { boards: unknown[] }).boards).toHaveLength(
      1,
    );

    const del = await handle(req("DELETE", "/v1/boards/brd_7c1f"));
    expect(del.status).toBe(200);
    expect(
      ((await del.json()) as { board: { enabled: boolean } }).board.enabled,
    ).toBe(false);

    const again = await handle(req("PUT", "/v1/boards/brd_7c1f", SETTINGS));
    expect(
      ((await again.json()) as { board: { enabled: boolean } }).board.enabled,
    ).toBe(true);
  });

  test("duplicate invitees are kept once", async () => {
    const { handle, store } = setup();
    await handle(
      req("PUT", "/v1/boards/brd_7c1f", {
        ...SETTINGS,
        invitees: ["@ana:example.test", "@ana:example.test"],
      }),
    );
    expect(store.getBoard("brd_7c1f")?.invitees).toEqual(["@ana:example.test"]);
  });

  test("no token, a wrong one, or the hash itself is 401 and changes nothing", async () => {
    const { handle, store } = setup();
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${OPERATOR_TOKEN_SHA256}` },
      { authorization: OPERATOR_TOKEN },
    ]) {
      for (const [method, path] of [
        ["GET", "/v1/boards"],
        ["PUT", "/v1/boards/brd_7c1f"],
        ["DELETE", "/v1/boards/brd_7c1f"],
      ] as const) {
        const response = await handle(req(method, path, SETTINGS, headers));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
    }
    expect(store.listBoards()).toEqual([]);
  });

  test("a board id that is not one is 400", async () => {
    const { handle } = setup();
    for (const id of ["7c1f", "brd_", "brd_a%20b", "brd_%E0%A4%A", "crd_1"]) {
      const response = await handle(req("PUT", `/v1/boards/${id}`, SETTINGS));
      expect(response.status).toBe(400);
    }
  });

  test("bad settings are 400 and name the field", async () => {
    const { handle, store } = setup();
    const cases: Array<[unknown, string]> = [
      ["{nope", "not JSON"],
      [[], "the body is not an object"],
      [{ ...SETTINGS, spTenantId: "" }, "spTenantId is not a tenant id"],
      [{ ...SETTINGS, orgId: 3 }, "orgId is not an organization id"],
      [
        { ...SETTINGS, invitees: "@ana:example.test" },
        "invitees is not a list",
      ],
      [
        { ...SETTINGS, invitees: ["ana"] },
        "invitees holds a value that is not a Matrix user id",
      ],
      [
        { ...SETTINGS, invitees: ["@Ana:example.test"] },
        "invitees holds a value that is not a Matrix user id",
      ],
      [
        {
          ...SETTINGS,
          invitees: Array.from({ length: 51 }, (_, i) => `@u${i}:example.test`),
        },
        "invitees has more than 50",
      ],
    ];
    for (const [body, error] of cases) {
      const response = await handle(req("PUT", "/v1/boards/brd_7c1f", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(store.listBoards()).toEqual([]);
  });

  test("disabling a board never opted in is 404", async () => {
    const { handle } = setup();
    expect((await handle(req("DELETE", "/v1/boards/brd_none"))).status).toBe(
      404,
    );
  });

  test("other methods are 405", async () => {
    const { handle } = setup();
    expect((await handle(req("POST", "/v1/boards", SETTINGS))).status).toBe(
      405,
    );
    expect(
      (await handle(req("PATCH", "/v1/boards/brd_7c1f", SETTINGS))).status,
    ).toBe(405);
  });
});
