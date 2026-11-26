/**
 * The superdial token service's routes (C5). Served only when its settings are present.
 *
 * - `POST /v1/token` with `{room_id, device_id, openid_token}`: the OpenID token is checked with
 *   the homeserver (who the caller is: never a user id from the body), the hub is asked whether
 *   that user may call in that room (C4), and a LiveKit token is minted for identity
 *   `{user_id}:{device_id}` in room `base64url_nopad(sha256(room_id))`:
 *   `200 {url, jwt, identity, livekit_room}`. A hub refusal is
 *   `403 {"errcode":"M_FORBIDDEN","reason":<C4 reason>}`.
 * - `POST /v1/delayed-leave` with `{room_id, device_id, delay_id, openid_token}`: the same two
 *   checks, and the device must be one the homeserver lists for that user; the delay is kept by
 *   the delayed-leave loop: `204`.
 * - `POST /v1/livekit-webhook`: LiveKit's webhook, read only when signed with the API secret;
 *   `200`, or `401`.
 *
 * Answers the contract does not name: `400` (`M_BAD_JSON`, `M_INVALID_PARAM`) for a body that is
 * not a request, `401 M_UNAUTHORIZED` for an OpenID token the homeserver does not accept, `413`,
 * and `503 M_UNKNOWN` when the homeserver, the hub or LiveKit cannot answer. The OpenID token,
 * the JWT and the delay id never reach a log.
 */
import {
  CallUpstreamError,
  fieldOf,
  isDelayId,
  isDeviceId,
  isRoomId,
  livekitIdentity,
  livekitRoomName,
  type CallHomeserver,
  type DelayedLeaves,
  type LiveKit,
  type MembershipCheck,
} from "../calls/index.ts";
import { readBody } from "./body.ts";

export const TOKEN_PATH = "/v1/token";
export const DELAYED_LEAVE_PATH = "/v1/delayed-leave";
export const LIVEKIT_WEBHOOK_PATH = "/v1/livekit-webhook";
export const SUPERDIAL_PATHS: readonly string[] = [
  TOKEN_PATH,
  DELAYED_LEAVE_PATH,
  LIVEKIT_WEBHOOK_PATH,
];

/** A token or delayed-leave request is a few hundred bytes. */
const MAX_REQUEST_BODY = 16 * 1024;
/** LiveKit's webhook carries the room and the participant with its tracks. */
const MAX_WEBHOOK_BODY = 256 * 1024;

export interface SuperdialDeps {
  homeserver: Pick<CallHomeserver, "verifyOpenId">;
  hub: MembershipCheck;
  livekit: Pick<LiveKit, "url" | "mint" | "receive">;
  leaves: Pick<DelayedLeaves, "register" | "onEvent">;
  /** The device ids the homeserver lists for a user. Throws when it cannot say. */
  userDevices(userId: string): Promise<string[]>;
  log?: (line: string) => void;
}

const matrixError = (
  status: number,
  errcode: string,
  error: string,
): Response => Response.json({ errcode, error }, { status });

/** A refusal, by C5: 403 with the reason. */
const forbidden = (reason: string): Response =>
  Response.json({ errcode: "M_FORBIDDEN", reason }, { status: 403 });

/** A request's caller, or the answer that ends it. */
type Caller =
  | {
      ok: true;
      userId: string;
      roomId: string;
      deviceId: string;
      body: unknown;
    }
  | { ok: false; response: Response };

export function createSuperdialHandler(
  deps: SuperdialDeps & { log: (line: string) => void },
) {
  const { log } = deps;

  const unavailable = (error: unknown): Response => {
    log(
      `superdial: ${error instanceof CallUpstreamError ? error.message : "an upstream could not answer"}`,
    );
    return matrixError(503, "M_UNKNOWN", "the call service cannot answer now");
  };

  /** Read the body, check its ids, and learn from the homeserver and the hub who is calling. */
  async function caller(request: Request): Promise<Caller> {
    const bytes = await readBody(request, MAX_REQUEST_BODY);
    if (bytes === null) {
      return {
        ok: false,
        response: matrixError(413, "M_TOO_LARGE", "the body is too large"),
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return {
        ok: false,
        response: matrixError(
          400,
          "M_BAD_JSON",
          "the body is not a JSON object",
        ),
      };
    }
    const roomId = fieldOf(body, "room_id");
    const deviceId = fieldOf(body, "device_id");
    const openid = fieldOf(body, "openid_token");
    if (!isRoomId(roomId)) {
      return { ok: false, response: invalid("room_id is not a room id") };
    }
    if (!isDeviceId(deviceId)) {
      return { ok: false, response: invalid("device_id is not a device id") };
    }
    if (typeof openid !== "object" || openid === null) {
      return { ok: false, response: invalid("openid_token is not an object") };
    }
    let userId: string | null;
    try {
      userId = await deps.homeserver.verifyOpenId(openid);
    } catch (error) {
      return { ok: false, response: unavailable(error) };
    }
    if (userId === null) {
      return {
        ok: false,
        response: matrixError(
          401,
          "M_UNAUTHORIZED",
          "the OpenID token was not accepted",
        ),
      };
    }
    return { ok: true, userId, roomId, deviceId, body };
  }

  /** Ask the hub; null when the caller may call, else the answer that ends the request. */
  async function membership(
    userId: string,
    roomId: string,
  ): Promise<Response | null> {
    try {
      const answer = await deps.hub.check(userId, roomId);
      if (answer.allowed) return null;
      log(`superdial: ${userId} may not call in ${roomId} (${answer.reason})`);
      return forbidden(answer.reason);
    } catch (error) {
      return unavailable(error);
    }
  }

  async function token(request: Request): Promise<Response> {
    const c = await caller(request);
    if (!c.ok) return c.response;
    const refused = await membership(c.userId, c.roomId);
    if (refused !== null) return refused;
    const identity = livekitIdentity(c.userId, c.deviceId);
    const livekitRoom = livekitRoomName(c.roomId);
    const jwt = await deps.livekit.mint(identity, c.userId, livekitRoom);
    log(`superdial: a token for ${identity} in ${livekitRoom}`);
    return Response.json({
      url: deps.livekit.url,
      jwt,
      identity,
      livekit_room: livekitRoom,
    });
  }

  async function delayedLeave(request: Request): Promise<Response> {
    const c = await caller(request);
    if (!c.ok) return c.response;
    const delayId = fieldOf(c.body, "delay_id");
    if (!isDelayId(delayId)) return invalid("delay_id is not a delay id");
    let devices: string[];
    try {
      devices = await deps.userDevices(c.userId);
    } catch {
      return unavailable(new CallUpstreamError("homeserver", "device list"));
    }
    if (!devices.includes(c.deviceId)) {
      log(`superdial: ${c.userId} named a device that is not theirs`);
      return forbidden("not_your_device");
    }
    const refused = await membership(c.userId, c.roomId);
    if (refused !== null) return refused;
    const identity = livekitIdentity(c.userId, c.deviceId);
    const livekitRoom = livekitRoomName(c.roomId);
    await deps.leaves.register({
      livekitRoom,
      identity,
      userId: c.userId,
      roomId: c.roomId,
      delayId,
    });
    log(
      `superdial: the delayed leave of ${identity} in ${livekitRoom} is kept`,
    );
    return new Response(null, { status: 204 });
  }

  async function webhook(request: Request): Promise<Response> {
    const bytes = await readBody(request, MAX_WEBHOOK_BODY);
    if (bytes === null) {
      return matrixError(413, "M_TOO_LARGE", "the body is too large");
    }
    const header = request.headers.get("authorization");
    const authorization = header?.replace(/^Bearer\s+/i, "").trim() ?? null;
    const event = await deps.livekit.receive(
      new TextDecoder().decode(bytes),
      authorization,
    );
    if (event === null) {
      return matrixError(401, "M_UNAUTHORIZED", "the webhook is not signed");
    }
    await deps.leaves.onEvent(event);
    return Response.json({});
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return matrixError(405, "M_UNRECOGNIZED", "method not allowed");
    }
    const { pathname } = new URL(request.url);
    if (pathname === TOKEN_PATH) return token(request);
    if (pathname === DELAYED_LEAVE_PATH) return delayedLeave(request);
    return webhook(request);
  };
}

const invalid = (error: string): Response =>
  matrixError(400, "M_INVALID_PARAM", error);
