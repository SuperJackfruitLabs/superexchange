/**
 * The AgentPod hub's membership check (C4): is this person joined to this room, and is it a
 * bridge-mode agent's room with calls on? SuperExchange cannot see agent rooms; the hub can.
 *
 * `POST {SUPERDIAL_HUB_URL}/internal/superdial/membership`, `Authorization: Bearer
 * <SUPERDIAL_MEMBERSHIP_TOKEN>`, `{"user_id","room_id"}`. A hub that refuses the token, fails, or
 * answers anything but C4's two shapes is `CallUpstreamError("hub")`: never an answer.
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

export function createMembershipCheck(
  deps: MembershipCheckDeps,
): MembershipCheck {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const url = `${deps.hubUrl.replace(/\/+$/, "")}${MEMBERSHIP_PATH}`;

  return {
    async check(userId, roomId) {
      let status: number;
      let json: unknown = null;
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${deps.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ user_id: userId, room_id: roomId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        const text = await response.text();
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
      } catch {
        throw new CallUpstreamError("hub", "unreachable");
      }
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
