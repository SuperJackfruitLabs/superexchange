/**
 * What a board opted in to SuperExchange is: its SuperPipeline board id, the SuperPipeline tenant
 * and Organization it belongs to, and the Matrix users invited to its room. The shapes are checked
 * here, once, for every caller.
 */

/** A SuperPipeline board id: `brd_` and up to 64 letters, digits, `_` or `-`. */
export const BOARD_ID = /^brd_[A-Za-z0-9_-]{1,64}$/;

/** A tenant or organization id: 1 to 128 letters, digits, `_`, `-`, `.` or `:`. */
export const OWNER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A Matrix user id, `@localpart:server`, at most 255 characters (the spec's limit). */
const MATRIX_USER_ID = /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** The most users one board's room is opened to here. */
export const MAX_INVITEES = 50;

export const isBoardId = (v: unknown): v is string =>
  typeof v === "string" && BOARD_ID.test(v);

export const isMatrixUserId = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 255 && MATRIX_USER_ID.test(v);

export interface BoardSettings {
  spTenantId: string;
  orgId: string;
  invitees: string[];
}

/** The settings in a request body, or the first problem with it. */
export function parseBoardSettings(
  body: unknown,
): { ok: true; settings: BoardSettings } | { ok: false; problem: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, problem: "the body is not an object" };
  }
  const { spTenantId, orgId, invitees } = body as Record<string, unknown>;
  if (typeof spTenantId !== "string" || !OWNER_ID.test(spTenantId)) {
    return { ok: false, problem: "spTenantId is not a tenant id" };
  }
  if (typeof orgId !== "string" || !OWNER_ID.test(orgId)) {
    return { ok: false, problem: "orgId is not an organization id" };
  }
  if (!Array.isArray(invitees)) {
    return { ok: false, problem: "invitees is not a list" };
  }
  if (invitees.length > MAX_INVITEES) {
    return { ok: false, problem: `invitees has more than ${MAX_INVITEES}` };
  }
  if (!invitees.every(isMatrixUserId)) {
    return {
      ok: false,
      problem: "invitees holds a value that is not a Matrix user id",
    };
  }
  return {
    ok: true,
    settings: { spTenantId, orgId, invitees: [...new Set(invitees)] },
  };
}
