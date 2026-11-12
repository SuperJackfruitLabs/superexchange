/**
 * The homeserver transactions already applied, and the boards an operator has pointed at this
 * service.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { Board, Store } from "./model.ts";

interface BoardRow {
  board_id: string;
  sp_tenant_id: string;
  org_id: string;
  invitees: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type BoardsQueries = Pick<
  Store,
  | "claimTransaction"
  | "upsertBoard"
  | "disableBoard"
  | "getBoard"
  | "listBoards"
>;

export function boardsQueries(
  db: Database,
  stamp: () => string,
): BoardsQueries {
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
  };
}
