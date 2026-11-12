/**
 * SuperPipeline, as board chat needs it: resolving a gate as the person who answered, and reading
 * a board's gates with this service's own token for the sweep.
 *
 * Resolving **as the person who answered**, with an assertion minted for that answer, is ported
 * from the AgentPod hub's `services/board-chat/gate-resolve.ts` (`resolveGateAtSuperpipeline`):
 * `POST /v1/boards/:boardId/gates/:gateId/resolve` with `Authorization: Bearer <assertion>` and
 * `{ decision, comment?, approvalSubjectId?, approvalSubjectDigest? }`. Calling with this
 * service's own token instead would attribute every approval to one account and void
 * SuperPipeline's separation-of-duties check; that is why the token is minted per answer rather
 * than held.
 *
 * The outcome is `{ ok: true }` or a code: the assertion's (`IDENTITY_UNAVAILABLE`,
 * `ASSERTION_REFUSED`, `ASSERTION_MISMATCH`), `UNREACHABLE` when the board could not be reached,
 * or the board's own `{ error: { code } }` (`GATE_NOT_PENDING`, …), else `HTTP_<status>`.
 *
 * Reading (`createSuperpipelineReads`) is this service's own: a service token on `gates:read`
 * (the organization plane's, `accounts.ts`), on `GET /v1/boards/:boardId/gates/pending` (the
 * board's pending gates, each a `gate.pending` body) and `GET /v1/boards/:boardId/gates/:gateId`
 * (one gate, and how it was decided). Only reads: deciding stays with the person. A refusal
 * throws `SuperpipelineError`, because "nothing pending" and "this token is refused" must never
 * read alike; a 401 also drops the held token, so the next read asks the plane for a new one.
 */
import { assertionFailureCode, type ServiceTokens } from "./accounts.ts";

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

/** SuperPipeline did not answer a read: its status (0 when it could not be reached) and code. */
export class SuperpipelineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(
      `SuperPipeline answered ${status === 0 ? "nothing" : status} (${code})`,
    );
    this.name = "SuperpipelineError";
  }
}

/** One gate as its board reads it now, kept to what a receipt needs. */
export interface BoardGate {
  /** `pending` or `resolved`; anything else is a shape this service does not model. */
  status: string;
  decision: string | null;
  /** Who decided: a principal id, never said in a room; null when the board does not say. */
  decidedBy: string | null;
  /** On a choice gate, the variant an approval chose; null otherwise. */
  chosen: { id: string; label: string } | null;
  /** A held approval's release time, when the board says one holds it. */
  heldUntil: string | null;
  /** Who pulled a held approval back (a principal id), when one was. */
  pulledBackBy: string | null;
}

export interface SuperpipelineReads {
  /** The board's pending gates, unchecked: each is read with treaty's `isGatePending`. */
  pendingGates(boardId: string): Promise<unknown[]>;
  /** One gate. Throws `SuperpipelineError` when the board does not answer with one. */
  gate(boardId: string, gateId: string): Promise<BoardGate>;
}

export interface ReadsDeps {
  /** SuperPipeline's API URL. */
  baseUrl: string;
  /** This service's token for SuperPipeline. */
  tokens: ServiceTokens;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSuperpipelineReads(deps: ReadsDeps): SuperpipelineReads {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const enc = encodeURIComponent;

  async function read(path: string): Promise<unknown> {
    const token = await deps.tokens.get();
    let response: Response;
    let json: unknown;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        // Boards are swept one at a time: one that never answers must not stall the rest.
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      });
      json = await response.json().catch(() => null);
    } catch {
      // Not chained: a fetch error can quote its request, and the request carries the token.
      throw new SuperpipelineError(0, "unreachable");
    }
    if (response.ok) return json;
    if (response.status === 401) deps.tokens.invalidate();
    throw new SuperpipelineError(
      response.status,
      errorCode(json) ?? `HTTP_${response.status}`,
    );
  }

  return {
    async pendingGates(boardId) {
      const body = await read(`/v1/boards/${enc(boardId)}/gates/pending`);
      const gates = field(body, "gates");
      if (!Array.isArray(gates))
        throw new SuperpipelineError(200, "malformed_response");
      return gates as unknown[];
    },

    async gate(boardId, gateId) {
      const body = await read(
        `/v1/boards/${enc(boardId)}/gates/${enc(gateId)}`,
      );
      const g = field(body, "gate");
      const status = field(g, "status");
      if (typeof status !== "string")
        throw new SuperpipelineError(200, "malformed_response");
      const text = (v: unknown) =>
        typeof v === "string" && v !== "" ? v : null;
      return {
        status,
        decision: text(field(g, "decision")),
        decidedBy: text(field(g, "decidedBy")),
        chosen: chosenVariantOf(field(g, "variants")),
        heldUntil: text(field(g, "heldUntil")),
        pulledBackBy: text(field(field(g, "pulledBack"), "by")),
      };
    },
  };
}

/** A field of a JSON value, or undefined when it is not an object or lacks it. */
function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null && key in json
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The variant a choice gate's read marks `chosen`, or null when there is none or it cannot be
 * named from the read (the hub's `chosenVariantOf`). Its label is cut to one short line.
 */
function chosenVariantOf(
  variants: unknown,
): { id: string; label: string } | null {
  if (!Array.isArray(variants)) return null;
  for (const v of variants) {
    if (field(v, "chosen") !== true) continue;
    const id = field(v, "id");
    const label = field(v, "label");
    if (typeof id === "string" && typeof label === "string" && label.trim()) {
      return { id, label: label.replace(/\s+/g, " ").trim().slice(0, 80) };
    }
  }
  return null;
}
