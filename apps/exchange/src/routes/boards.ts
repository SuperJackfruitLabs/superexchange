/**
 * The operator's board opt-in API: which boards this service projects.
 *
 * - `GET /v1/boards`: every board, enabled or not.
 * - `PUT /v1/boards/:boardId` with `{spTenantId, orgId, invitees}`: opt a board in (or replace
 *   its settings) and enable it.
 * - `DELETE /v1/boards/:boardId`: disable it. The row stays, so it can be listed and re-enabled.
 *
 * Every request carries `Authorization: Bearer <token>`, whose SHA-256 must equal
 * `SUPEREXCHANGE_OPERATOR_TOKEN_SHA256`. The check is constant-time and comes before the body is
 * read; a refusal is 401 and says nothing else.
 */
import { tokenMatchesSha256 } from "../config.ts";
import { isBoardId, parseBoardSettings } from "../board-chat/index.ts";
import type { Board, Store } from "../store/index.ts";
import { readBody, tooLarge } from "./body.ts";

export const BOARDS_PATH = "/v1/boards";

const MAX_BOARD_BODY = 64 * 1024;

export interface BoardsDeps {
  /** The SHA-256 of the operator's token, 64 hex digits. */
  operatorTokenSha256: string;
  store: Pick<
    Store,
    "upsertBoard" | "disableBoard" | "getBoard" | "listBoards"
  >;
  log?: (line: string) => void;
}

export function createBoardsHandler(deps: BoardsDeps) {
  const log = deps.log ?? console.log;
  return async (request: Request): Promise<Response> => {
    const header = request.headers.get("authorization") ?? "";
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? "";
    if (
      presented === "" ||
      !tokenMatchesSha256(deps.operatorTokenSha256, presented)
    ) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }

    const { pathname } = new URL(request.url);
    if (pathname === BOARDS_PATH) {
      if (request.method !== "GET") return notAllowed();
      return Response.json({ boards: deps.store.listBoards().map(view) });
    }

    const segment = pathname.slice(BOARDS_PATH.length + 1);
    if (segment.includes("/")) return notFound();
    // Board ids need no escaping, so a percent-encoded segment is never one.
    const boardId = segment;
    if (!isBoardId(boardId)) {
      return Response.json({ error: "not a board id" }, { status: 400 });
    }

    if (request.method === "PUT") {
      const bytes = await readBody(request, MAX_BOARD_BODY);
      if (bytes === null) return tooLarge();
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return Response.json({ error: "not JSON" }, { status: 400 });
      }
      const parsed = parseBoardSettings(body);
      if (!parsed.ok) {
        return Response.json({ error: parsed.problem }, { status: 400 });
      }
      const board = deps.store.upsertBoard({ boardId, ...parsed.settings });
      log(`boards: ${boardId} enabled`);
      return Response.json({ board: view(board) });
    }

    if (request.method === "DELETE") {
      const board = deps.store.disableBoard(boardId);
      if (board === null) return notFound();
      log(`boards: ${boardId} disabled`);
      return Response.json({ board: view(board) });
    }

    if (request.method === "GET") {
      const board = deps.store.getBoard(boardId);
      return board ? Response.json({ board: view(board) }) : notFound();
    }
    return notAllowed();
  };
}

function view(board: Board) {
  return {
    boardId: board.boardId,
    spTenantId: board.spTenantId,
    orgId: board.orgId,
    invitees: board.invitees,
    enabled: board.enabled,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });
const notAllowed = () =>
  Response.json({ error: "method not allowed" }, { status: 405 });
