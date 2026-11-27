/**
 * The AgentPod hub's membership check (C4): is this person joined to this room, and is it a
 * bridge-mode agent's room with calls on? SuperExchange cannot see agent rooms; the hub can.
 *
 * `POST {SUPERDIAL_HUB_URL}/internal/superdial/membership`, `Authorization: Bearer
 * <SUPERDIAL_MEMBERSHIP_TOKEN>`, `{"user_id","room_id"}`. A hub that refuses the token, fails, or
 * answers anything but C4's two shapes is `CallUpstreamError("hub")`: never an answer.
 *
 * A slow hub is not a refusal. Each attempt waits `MEMBERSHIP_TIMEOUT_MS`, and one that times out
 * or answers 5xx is tried once more; only when both fail is it an error (503 at `/v1/token`). E1
 * (2026-11-27) met a hub that took 5 s over its first, cold answer while the timeout was 5 s. A
 * refused token, another 4xx, a hub that cannot be reached at all, or a malformed answer is not
 * retried: asking again would not change it.
 */
import { CallUpstreamError, fieldOf } from "./naming.ts";

export type Membership =
  | { allowed: true; agentUserId: string; stationId: string }
  | { allowed: false; reason: string };

export interface MembershipCheck {
  check(userId: string, roomId: string): Promise<Membership>;
}

export interface MembershipCheckDeps {
  hubUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const MEMBERSHIP_PATH = "/internal/superdial/membership";
export const MEMBERSHIP_TIMEOUT_MS = 15_000;

/** How one request went: the hub's status and JSON, or why there is none. */
type Attempt = { status: number; json: unknown } | "timeout" | "unreachable";

/** A timeout or a 5xx may pass; a refusal, an unreachable hub or a malformed answer will not. */
function worthRetrying(attempt: Attempt): boolean {
  return (
    attempt === "timeout" ||
    (typeof attempt === "object" && attempt.status >= 500)
  );
}

export function createMembershipCheck(
  deps: MembershipCheckDeps,
): MembershipCheck {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? MEMBERSHIP_TIMEOUT_MS;
  const url = `${deps.hubUrl.replace(/\/+$/, "")}${MEMBERSHIP_PATH}`;

  /** One request: its status and JSON, `"timeout"`, or `"unreachable"`. */
  async function attempt(userId: string, roomId: string): Promise<Attempt> {
    // A timer of our own, not `AbortSignal.timeout`: Bun's fires late when nothing else holds
    // the event loop, and this way a timeout is told apart from a refused connection for sure.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ user_id: userId, room_id: roomId }),
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
      return timedOut ? "timeout" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(userId, roomId) {
      let answer = await attempt(userId, roomId);
      if (worthRetrying(answer)) answer = await attempt(userId, roomId);
      if (answer === "timeout") throw new CallUpstreamError("hub", "timed out");
      if (answer === "unreachable") {
        throw new CallUpstreamError("hub", "unreachable");
      }
      const { status, json } = answer;
      if (status === 401) {
        throw new CallUpstreamError(
          "hub",
          "it refused SUPERDIAL_MEMBERSHIP_TOKEN",
        );
      }
      if (status !== 200) {
        throw new CallUpstreamError("hub", `membership ${status}`);
      }
      const allowed = fieldOf(json, "allowed");
      const agentUserId = fieldOf(json, "agent_user_id");
      const stationId = fieldOf(json, "station_id");
      const reason = fieldOf(json, "reason");
      if (
        allowed === true &&
        typeof agentUserId === "string" &&
        typeof stationId === "string"
      ) {
        return { allowed: true, agentUserId, stationId };
      }
      if (allowed === false && typeof reason === "string") {
        return { allowed: false, reason };
      }
      throw new CallUpstreamError("hub", "membership answer malformed");
    },
  };
}
