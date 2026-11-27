/**
 * The homeserver, as the token service may reach it: never as a user, and never through the
 * admin API (C5).
 *
 * - `GET /_matrix/federation/v1/openid/userinfo?access_token=…`: who a caller's OpenID token
 *   names. tuwunel answers it with federation off. Only a token issued by this homeserver
 *   (`matrix_server_name` equal to `MATRIX_SERVER_NAME`) is asked about, so a caller cannot point
 *   the check at another server, and only a user of this server is accepted back.
 * - `POST /_matrix/client/unstable/org.matrix.msc4140/delayed_events/{delay_id}/restart` (or
 *   `/send`) with `{}` and no access token: tuwunel takes the delay id as the authority on this
 *   path form. The body form (`…/{delay_id}` with `{"action":…}`) needs an access token on
 *   tuwunel 2.0.0, which answers it 401 `M_MISSING_TOKEN` without one.
 *
 * The access token and the delay id are secrets of their holders: neither reaches an error.
 */
import { CallUpstreamError, fieldOf } from "./naming.ts";

/**
 * How long a delayed-event restart or send may take. Under the delayed-leave loop's restart
 * interval, so a restart that hangs gives up before the next one is due.
 */
export const DELAYED_EVENT_TIMEOUT_MS = 2_500;

export interface CallHomeserverDeps {
  homeserverUrl: string;
  serverName: string;
  fetch?: typeof fetch;
  /** The OpenID check's timeout; 5 s. */
  timeoutMs?: number;
  /** The delayed-event action's timeout; `DELAYED_EVENT_TIMEOUT_MS`. */
  delayedEventTimeoutMs?: number;
}

export interface CallHomeserver {
  /**
   * The user an OpenID token (the homeserver's `/openid/request_token` answer, as the caller sent
   * it) names, or null when it names nobody here. Throws `CallUpstreamError` when the homeserver
   * cannot say.
   */
  verifyOpenId(token: unknown): Promise<string | null>;
  /**
   * Restart or send a delayed event. `gone` when the homeserver no longer has it (it fired, was
   * sent or was cancelled). Throws `CallUpstreamError` when it cannot say, or asks to wait.
   */
  delayedEvent(
    delayId: string,
    action: "restart" | "send",
  ): Promise<"ok" | "gone">;
}

/** An access token as a homeserver issues one: printable, no space. */
const ACCESS_TOKEN = /^[\x21-\x7e]{1,1024}$/;

export function createCallHomeserver(deps: CallHomeserverDeps): CallHomeserver {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const delayedEventTimeoutMs =
    deps.delayedEventTimeoutMs ?? DELAYED_EVENT_TIMEOUT_MS;
  const base = deps.homeserverUrl.replace(/\/+$/, "");
  const userSuffix = `:${deps.serverName}`;

  async function request(
    url: string,
    init: RequestInit,
    what: string,
    waitMs: number,
  ): Promise<{ status: number; json: unknown }> {
    // A timer of our own, not `AbortSignal.timeout`: Bun's fires late when nothing else holds
    // the event loop (as in hub.ts), and a restart must give up well before its delay runs out.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const response = await doFetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch {
      // Not chained: the cause can quote the URL, which carries a secret.
      throw new CallUpstreamError("homeserver", `${what} unreachable`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async verifyOpenId(token) {
      const accessToken = fieldOf(token, "access_token");
      const server = fieldOf(token, "matrix_server_name");
      if (server !== deps.serverName) return null;
      if (typeof accessToken !== "string" || !ACCESS_TOKEN.test(accessToken)) {
        return null;
      }
      const url = `${base}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(accessToken)}`;
      const answer = await request(
        url,
        { method: "GET" },
        "userinfo",
        timeoutMs,
      );
      if (answer.status === 401 || answer.status === 403) return null;
      if (answer.status !== 200) {
        throw new CallUpstreamError("homeserver", `userinfo ${answer.status}`);
      }
      const sub = fieldOf(answer.json, "sub");
      if (
        typeof sub !== "string" ||
        !sub.startsWith("@") ||
        !sub.endsWith(userSuffix) ||
        sub.length <= userSuffix.length + 1
      ) {
        return null;
      }
      return sub;
    },

    async delayedEvent(delayId, action) {
      const url = `${base}/_matrix/client/unstable/org.matrix.msc4140/delayed_events/${encodeURIComponent(delayId)}/${action}`;
      const answer = await request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        `delayed event ${action}`,
        delayedEventTimeoutMs,
      );
      if (answer.status >= 200 && answer.status < 300) return "ok";
      // 404 (unknown), 409 (already sent or cancelled) and the like: the delay is gone. 401 and
      // 403 are the homeserver refusing the call itself, which forgetting would hide.
      if (
        answer.status >= 400 &&
        answer.status < 500 &&
        answer.status !== 401 &&
        answer.status !== 403 &&
        answer.status !== 429
      ) {
        return "gone";
      }
      throw new CallUpstreamError(
        "homeserver",
        `delayed event ${action} ${answer.status}`,
      );
    },
  };
}
