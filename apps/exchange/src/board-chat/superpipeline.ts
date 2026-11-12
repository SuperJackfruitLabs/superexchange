/**
 * Resolving a gate at SuperPipeline **as the person who answered**, with an assertion minted for
 * that answer.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-resolve.ts`
 * (`resolveGateAtSuperpipeline`): `POST /v1/boards/:boardId/gates/:gateId/resolve` with
 * `Authorization: Bearer <assertion>` and `{ decision, comment?, approvalSubjectId?,
 * approvalSubjectDigest? }`. Calling with this service's own token instead would attribute every
 * approval to one account and void SuperPipeline's separation-of-duties check; that is why the
 * token is minted per answer rather than held.
 *
 * The outcome is `{ ok: true }` or a code: the assertion's (`IDENTITY_UNAVAILABLE`,
 * `ASSERTION_REFUSED`, `ASSERTION_MISMATCH`), `UNREACHABLE` when the board could not be reached,
 * or the board's own `{ error: { code } }` (`GATE_NOT_PENDING`, …), else `HTTP_<status>`.
 */
import { assertionFailureCode } from "./accounts.ts";

export interface ResolveInput {
  boardId: string;
  gateId: string;
  /** The option id the person chose. Not checked against a list here: the board judges it. */
  decision: string;
  comment: string | null;
  principalId: string;
  senderMxid: string;
  /** gate.v2: the subject the person was shown, so the board can bind to it. */
  approvalSubject?: { id: string; digest: string };
}

export interface ResolveDeps {
  /** SuperPipeline's API URL. */
  baseUrl: string;
  /** An assertion for the person: the organization plane's, never this service's own token. */
  mint(subject: { principalId: string; senderMxid: string }): Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ResolveResult = { ok: true } | { ok: false; code: string };

export async function resolveGateAtSuperpipeline(
  input: ResolveInput,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  let token: string;
  try {
    token = await deps.mint({
      principalId: input.principalId,
      senderMxid: input.senderMxid,
    });
  } catch (error) {
    // Refused or unreachable is a failed outcome the caller reports, never a token-less call to
    // the board. Anything else throws.
    const code = assertionFailureCode(error);
    if (code === null) throw error;
    return { ok: false, code };
  }

  const base = deps.baseUrl.replace(/\/+$/, "");
  const path = `/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/resolve`;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        decision: input.decision,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.approvalSubject
          ? {
              approvalSubjectId: input.approvalSubject.id,
              approvalSubjectDigest: input.approvalSubject.digest,
            }
          : {}),
      }),
      // Answers are carried one at a time: a board that never answers must not stall the rest.
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch {
    // The network, not a refusal: a refusal is final and this is not.
    return { ok: false, code: "UNREACHABLE" };
  }
  if (response.ok) return { ok: true };

  // The code is what matters: the board answers 403 for SEPARATION_OF_DUTIES and 409 for
  // GATE_NOT_PENDING, different situations with the same shape.
  let code = `HTTP_${response.status}`;
  try {
    const found = errorCode(await response.json());
    if (found) code = found;
  } catch {
    // Keep the status-derived code.
  }
  return { ok: false, code };
}

/** `{ error: { code } }`'s code, or null. */
function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body))
    return null;
  const error = body.error;
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  return typeof error.code === "string" && error.code !== ""
    ? error.code.slice(0, 64)
    : null;
}
