/**
 * The organization plane (Accounts), as a gate answer needs it: who a Matrix sender is, and a
 * short-lived assertion that carries that person to SuperPipeline.
 *
 * Ported from the AgentPod hub's `auth/org-plane/client.ts` (the three calls), `assertion.ts`
 * (the `sub` check and the receipt codes) and the `principalForMatrixId` it wires for gates:
 *
 * - `GET /api/identities/matrix/:mxid`: the principal a Matrix id is linked to; 404 is nobody.
 * - `GET /api/principals/:id`: what kind of principal that is (`human`, `agent`, `service`), and
 *   its name for the receipt.
 * - `POST /api/token/assertion` with `{ identity: { system: "matrix", externalId }, audience }`:
 *   the plane resolves the person itself, so no caller can name whom to assert. The token's `sub`
 *   must be the principal resolved from the same sender, or the answer is refused.
 *
 * Every call carries this service's `svc_` credential as `Authorization: Bearer <id>:<secret>`,
 * and the credential appears nowhere else: not in an error, not in a log. A network failure or a
 * timeout is `AccountsError(0, "unreachable")`, with the underlying error dropped, because a fetch
 * error can quote its request.
 */
import type { ServiceCredential } from "../config.ts";

export class AccountsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(
      `the organization plane answered ${status === 0 ? "nothing" : status} (${code})`,
    );
    this.name = "AccountsError";
  }
}

/** The plane asserted somebody other than the principal the sender was resolved to. */
export class AssertionMismatch extends Error {
  constructor() {
    super(
      "the organization plane asserted somebody other than the sender's principal",
    );
    this.name = "AssertionMismatch";
  }
}

/** A principal a Matrix sender is linked to. */
export interface SenderPrincipal {
  id: string;
  /** `human`, `agent` or `service`; anything else is not a person. */
  kind: string;
  /** How a receipt names them: their display name, else their handle; null when neither is set. */
  label: string | null;
}

export interface Accounts {
  /**
   * The principal a Matrix id is linked to, or null when nobody is. Throws `AccountsError` when the
   * plane cannot say: "down" never reads as "unlinked".
   */
  principalForMatrixId(mxid: string): Promise<SenderPrincipal | null>;
  /**
   * An assertion for the sender, for `audience`; its `sub` must be `principalId`. Throws
   * `AccountsError` when the plane refuses or cannot be reached, `AssertionMismatch` when it
   * asserts somebody else.
   */
  assert(input: {
    principalId: string;
    senderMxid: string;
    audience: string;
  }): Promise<string>;
}

export interface AccountsDeps {
  url: string;
  credential: ServiceCredential;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A field of a JSON body, or undefined when the body is not an object or lacks it. */
function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null && key in json
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

export function createAccounts(deps: AccountsDeps): Accounts {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const base = deps.url.replace(/\/+$/, "");
  const authorization = `Bearer ${deps.credential.id}:${deps.credential.secret}`;
  const enc = encodeURIComponent;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      // Not chained: the cause can quote the request, and the request carries the credential.
      throw new AccountsError(0, "unreachable");
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** The body of a 2xx answer; null for a 404 when that is allowed; otherwise an AccountsError. */
  function ok(
    answer: { status: number; json: unknown },
    allowNotFound = false,
  ): unknown {
    if (answer.status >= 200 && answer.status < 300) return answer.json;
    if (allowNotFound && answer.status === 404) return null;
    const error = field(answer.json, "error");
    throw new AccountsError(
      answer.status,
      typeof error === "string" ? error.slice(0, 64) : "error",
    );
  }

  return {
    async principalForMatrixId(mxid) {
      const identity = ok(
        await call("GET", `/api/identities/matrix/${enc(mxid)}`),
        true,
      );
      if (identity === null) return null;
      const principalId = field(identity, "principalId");
      if (typeof principalId !== "string" || principalId === "") {
        throw new AccountsError(200, "malformed_response");
      }
      const principal = ok(
        await call("GET", `/api/principals/${enc(principalId)}`),
        true,
      );
      if (principal === null) return null;
      const kind = field(principal, "kind");
      if (typeof kind !== "string") {
        throw new AccountsError(200, "malformed_response");
      }
      const displayName = field(principal, "displayName");
      const handle = field(principal, "handle");
      const label =
        (typeof displayName === "string" ? displayName.trim() : "") ||
        (typeof handle === "string" ? handle : "") ||
        null;
      return { id: principalId, kind, label };
    },

    async assert({ principalId, senderMxid, audience }) {
      const answer = ok(
        await call("POST", "/api/token/assertion", {
          identity: { system: "matrix", externalId: senderMxid },
          audience,
        }),
      );
      const token = field(answer, "access_token");
      if (typeof token !== "string" || token === "") {
        throw new AccountsError(200, "malformed_response");
      }
      // Defence in depth: the plane's `sub` must be the principal the same sender was resolved
      // to. A mismatch means the link changed between the two reads, and the answer is refused
      // rather than recorded under somebody else.
      if (subjectOf(token) !== principalId) throw new AssertionMismatch();
      return token;
    },
  };
}

/** A JWT's `sub`, read without verifying it (SuperPipeline verifies), or undefined. */
export function subjectOf(token: string): unknown {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return field(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      "sub",
    );
  } catch {
    return undefined;
  }
}

/**
 * The receipt code for an assertion that could not be had, or null for any other error.
 *
 * - `IDENTITY_UNAVAILABLE`: the plane could not be reached, or answered 5xx: try again.
 * - `ASSERTION_REFUSED`: the plane answered and refused.
 * - `ASSERTION_MISMATCH`: the plane asserted somebody else.
 */
export function assertionFailureCode(
  error: unknown,
): "IDENTITY_UNAVAILABLE" | "ASSERTION_REFUSED" | "ASSERTION_MISMATCH" | null {
  if (error instanceof AssertionMismatch) return "ASSERTION_MISMATCH";
  if (error instanceof AccountsError) {
    return error.status === 0 || error.status >= 500
      ? "IDENTITY_UNAVAILABLE"
      : "ASSERTION_REFUSED";
  }
  return null;
}
