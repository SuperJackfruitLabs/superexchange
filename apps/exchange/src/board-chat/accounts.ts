/**
 * The organization plane (Accounts), as board chat needs it: who a Matrix sender is, a
 * short-lived assertion that carries that person to SuperPipeline, and this service's own token
 * for reading boards.
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
 * - `POST /api/token/service` with `{ audience }`: this service's own token for SuperPipeline,
 *   which the gate sweep reads boards with (`gates:read`). Held until shortly before it expires
 *   (`createServiceTokens`), never logged.
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
  /**
   * How a receipt names a principal (`GET /api/principals/:id`): display name, else handle; null
   * when the plane knows no such principal, or the id is not one. Throws `AccountsError` when the
   * plane cannot say.
   */
  principalLabel(principalId: string): Promise<string | null>;
  /** This service's own token for `audience`. Throws `AccountsError` when it cannot be had. */
  serviceToken(
    audience: string,
  ): Promise<{ accessToken: string; expiresIn: number }>;
}

/** A principal id as the plane writes one; anything else names nobody and is not asked about. */
const PRINCIPAL_ID = /^prn_[A-Za-z0-9_-]{1,64}$/;

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

  /** A principal's kind and label, or null when the plane knows no such principal. */
  async function principal(
    principalId: string,
  ): Promise<{ kind: string; label: string | null } | null> {
    const found = ok(
      await call("GET", `/api/principals/${enc(principalId)}`),
      true,
    );
    if (found === null) return null;
    const kind = field(found, "kind");
    if (typeof kind !== "string") {
      throw new AccountsError(200, "malformed_response");
    }
    const displayName = field(found, "displayName");
    const handle = field(found, "handle");
    const label =
      (typeof displayName === "string" ? displayName.trim() : "") ||
      (typeof handle === "string" ? handle : "") ||
      null;
    return { kind, label };
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
      const found = await principal(principalId);
      return found === null ? null : { id: principalId, ...found };
    },

    async principalLabel(principalId) {
      if (!PRINCIPAL_ID.test(principalId)) return null;
      return (await principal(principalId))?.label ?? null;
    },

    async serviceToken(audience) {
      const answer = ok(await call("POST", "/api/token/service", { audience }));
      const accessToken = field(answer, "access_token");
      const expiresIn = field(answer, "expires_in");
      if (
        typeof accessToken !== "string" ||
        accessToken === "" ||
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        throw new AccountsError(200, "malformed_response");
      }
      return { accessToken, expiresIn };
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
  return claimOf(token, "sub");
}

/** One claim of a JWT, read without verifying it, or undefined. */
export function claimOf(token: string, claim: string): unknown {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return field(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      claim,
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

/** How long before its expiry a held service token is replaced. */
export const SERVICE_TOKEN_MARGIN_MS = 60_000;

/** This service's token for one audience, held until shortly before it expires. */
export interface ServiceTokens {
  /** The held token, or a new one when none is held or it is about to expire. */
  get(): Promise<string>;
  /** Drop the held token: the audience refused it, so the next `get` asks for a new one. */
  invalidate(): void;
}

/**
 * Hold this service's token for `audience` until `SERVICE_TOKEN_MARGIN_MS` before it expires
 * (or half its life, when that is shorter). Callers at the same moment share one request; a
 * failed request holds nothing, so the next call asks again.
 */
export function createServiceTokens(deps: {
  accounts: Pick<Accounts, "serviceToken">;
  audience: string;
  now?: () => number;
}): ServiceTokens {
  const now = deps.now ?? Date.now;
  let held: { token: string; renewAt: number } | null = null;
  let asking: Promise<string> | null = null;

  return {
    get() {
      if (held !== null && now() < held.renewAt) {
        return Promise.resolve(held.token);
      }
      asking ??= (async () => {
        try {
          const asked = now();
          const { accessToken, expiresIn } = await deps.accounts.serviceToken(
            deps.audience,
          );
          const lifeMs = expiresIn * 1000;
          held = {
            token: accessToken,
            renewAt:
              asked + lifeMs - Math.min(SERVICE_TOKEN_MARGIN_MS, lifeMs / 2),
          };
          return accessToken;
        } finally {
          asking = null;
        }
      })();
      return asking;
    },
    invalidate() {
      held = null;
    },
  };
}
