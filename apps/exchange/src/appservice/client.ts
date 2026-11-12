/**
 * The client-server API, spoken as this appservice's registration: every request carries the
 * `as_token`, and may assert one of the namespace's users with `?user_id=` (the spec's identity
 * assertion). Only what this slice needs: `whoami`, and registering a localpart with
 * `m.login.application_service`.
 *
 * `fetch` is injected so tests run without a homeserver. An error names the endpoint, the status
 * and the Matrix `errcode`, never the token and never the body the homeserver sent.
 */

export interface ClientDeps {
  /** Where the homeserver's client-server API answers. */
  homeserverUrl: string;
  /** The homeserver's server name, the part of a user id after the colon. */
  serverName: string;
  /** The registration's `as_token`. */
  asToken: string;
  fetch?: typeof fetch;
}

export class MatrixClientError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly errcode: string | null,
  ) {
    super(`${endpoint} answered ${status}${errcode ? ` ${errcode}` : ""}`);
    this.name = "MatrixClientError";
  }
}

/** A localpart the spec allows in a user id (lowercase, historical characters excluded). */
const LOCALPART = /^[a-z0-9._=\-/+]{1,200}$/;

export interface AppserviceClient {
  /**
   * Who the homeserver says this token is, or the asserted user when `asUser` is given. Throws
   * when the homeserver answers for somebody else.
   */
  whoami(asUser?: string): Promise<{ userId: string }>;
  /**
   * Register a user in this appservice's namespace. `created` is false when it already existed
   * (`M_USER_IN_USE`), which is not an error: registration is idempotent here.
   */
  register(localpart: string): Promise<{ userId: string; created: boolean }>;
}

export function createClient(deps: ClientDeps): AppserviceClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.homeserverUrl.replace(/\/+$/, "");

  async function call(
    endpoint: string,
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(init.query ?? {}))
      url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.asToken}`,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new MatrixClientError(endpoint, 0, null);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null)
        json = parsed as Record<string, unknown>;
    } catch {
      // A body that is not JSON reads as empty; the status still says what happened.
    }
    return { status: response.status, json };
  }

  const errcodeOf = (json: Record<string, unknown>) =>
    typeof json.errcode === "string" ? json.errcode.slice(0, 64) : null;

  return {
    async whoami(asUser) {
      const endpoint = "whoami";
      const { status, json } = await call(
        endpoint,
        "/_matrix/client/v3/account/whoami",
        { method: "GET", ...(asUser ? { query: { user_id: asUser } } : {}) },
      );
      if (status !== 200)
        throw new MatrixClientError(endpoint, status, errcodeOf(json));
      const userId = json.user_id;
      if (typeof userId !== "string")
        throw new MatrixClientError(endpoint, status, null);
      if (asUser !== undefined && userId !== asUser) {
        throw new MatrixClientError(endpoint, status, "M_WRONG_USER");
      }
      return { userId };
    },

    async register(localpart) {
      const endpoint = "register";
      if (!LOCALPART.test(localpart)) {
        throw new MatrixClientError(endpoint, 0, "M_INVALID_USERNAME");
      }
      const { status, json } = await call(
        endpoint,
        "/_matrix/client/v3/register",
        {
          method: "POST",
          body: {
            type: "m.login.application_service",
            username: localpart,
            inhibit_login: true,
          },
        },
      );
      if (status === 200 && typeof json.user_id === "string") {
        return { userId: json.user_id, created: true };
      }
      const errcode = errcodeOf(json);
      if (status === 400 && errcode === "M_USER_IN_USE") {
        return { userId: `@${localpart}:${deps.serverName}`, created: false };
      }
      throw new MatrixClientError(endpoint, status, errcode);
    },
  };
}
