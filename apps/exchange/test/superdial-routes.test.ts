import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import {
  CallUpstreamError,
  createLiveKit,
  livekitRoomName,
  type LiveKitEvent,
  type Membership,
} from "../src/calls/index.ts";
import type { DelayedLeave } from "../src/store/index.ts";
import { createHandler } from "../src/routes/index.ts";
import type { SuperdialDeps } from "../src/routes/superdial.ts";
import {
  HS_TOKEN,
  OPERATOR_TOKEN_SHA256,
  RELAY_SECRET,
  captureLog,
  tempStore,
} from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const KEY = "lk-key-for-tests";
const SECRET = "lk-secret-for-tests-0123456789abcdef";
const ACCESS = "openid-access-token-for-tests";
const ROOM = "!agentroom:s.example";
const OPENID = {
  access_token: ACCESS,
  token_type: "Bearer",
  matrix_server_name: "s.example",
  expires_in: 3600,
};

type Leave = Omit<DelayedLeave, "registeredAt" | "connectedAt">;

/** A response's JSON body, as an object (`{}` when it is not one). */
async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function setup(
  options: {
    /** Who the homeserver says the token names; absent, @p:s.example. */
    user?: string | null;
    /** The homeserver cannot answer. */
    homeserverDown?: true;
    membership?: Membership | "throw";
    devices?: string[] | "throw";
    superdial?: false;
  } = {},
) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const { log, lines } = captureLog();
  const verified: unknown[] = [];
  const checked: Array<[string, string]> = [];
  const registered: Leave[] = [];
  const events: LiveKitEvent[] = [];
  const superdial: SuperdialDeps = {
    homeserver: {
      verifyOpenId: (token) => {
        verified.push(token);
        return options.homeserverDown
          ? Promise.reject(new CallUpstreamError("homeserver", "userinfo 500"))
          : Promise.resolve(
              options.user === undefined ? "@p:s.example" : options.user,
            );
      },
    },
    hub: {
      check: (userId, roomId) => {
        checked.push([userId, roomId]);
        const m = options.membership ?? {
          allowed: true,
          agentUserId: "@agent_x:s.example",
          stationId: "station_1",
        };
        return m === "throw"
          ? Promise.reject(new CallUpstreamError("hub", "unreachable"))
          : Promise.resolve(m);
      },
    },
    livekit: createLiveKit(
      {
        livekitUrl: "wss://lk.example",
        livekitApiUrl: "https://lk.example",
        livekitApiKey: KEY,
        livekitApiSecret: SECRET,
      },
      { rooms: { getParticipant: () => Promise.reject(new Error("unused")) } },
    ),
    leaves: {
      register: (input) => {
        registered.push(input);
        return Promise.resolve();
      },
      onEvent: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    userDevices: () => {
      const d = options.devices ?? ["DEV", "OTHER"];
      return d === "throw"
        ? Promise.reject(new Error("keys/query answered 500"))
        : Promise.resolve(d);
    },
    log,
  };
  const handle = createHandler({
    config: {
      hsToken: HS_TOKEN,
      relayDeliverySecret: RELAY_SECRET,
      operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    },
    store: t.store,
    onEvents: () => {},
    ...(options.superdial === false ? {} : { superdial }),
    log,
  });
  return { handle, lines, verified, checked, registered, events };
}

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`http://exchange${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const tokenRequest = (overrides: Record<string, unknown> = {}) =>
  post("/v1/token", {
    room_id: ROOM,
    device_id: "DEV",
    openid_token: OPENID,
    ...overrides,
  });

const leaveRequest = (overrides: Record<string, unknown> = {}) =>
  post("/v1/delayed-leave", {
    room_id: ROOM,
    device_id: "DEV",
    delay_id: "syd_secret_1",
    openid_token: OPENID,
    ...overrides,
  });

async function signed(body: string, secret = SECRET): Promise<string> {
  const token = new AccessToken(KEY, secret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return token.toJwt();
}

describe("POST /v1/token (C5)", () => {
  test("a caller the hub allows gets a LiveKit token for that call", async () => {
    const s = setup();
    const response = await s.handle(tokenRequest());
    expect(response.status).toBe(200);
    const body = await json(response);
    const livekitRoom = livekitRoomName(ROOM);
    const jwt = typeof body.jwt === "string" ? body.jwt : "";
    expect(body).toEqual({
      url: "wss://lk.example",
      jwt,
      identity: "@p:s.example:DEV",
      livekit_room: livekitRoom,
    });
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.sub).toBe("@p:s.example:DEV");
    expect(claims.video?.room).toBe(livekitRoom);
    expect(s.verified).toEqual([OPENID]);
    // The hub is asked about the user the homeserver named, never one the body names.
    expect(s.checked).toEqual([["@p:s.example", ROOM]]);
    for (const line of s.lines) {
      expect(line).not.toContain(ACCESS);
      expect(line).not.toContain(jwt);
    }
  });

  test("the answer has treaty's shape, for a room id with or without a server part", async () => {
    for (const roomId of [
      ROOM,
      "!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM",
    ]) {
      const s = setup();
      const body = await json(
        await s.handle(tokenRequest({ room_id: roomId })),
      );
      expect(body.url).toMatch(/^wss?:\/\//);
      expect(body.identity).toMatch(/^@[^:]+:.+:[^:]+$/);
      expect(body.livekit_room).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.livekit_room).toBe(livekitRoomName(roomId));
      expect(s.checked).toEqual([["@p:s.example", roomId]]);
    }
  });

  test("a user id in the body is not believed", async () => {
    const s = setup();
    const response = await s.handle(
      tokenRequest({ user_id: "@someone_else:s.example" }),
    );
    expect((await json(response)).identity).toBe("@p:s.example:DEV");
    expect(s.checked).toEqual([["@p:s.example", ROOM]]);
  });

  test("each refusal the hub gives is 403 with its reason, and nothing is minted", async () => {
    for (const reason of [
      "not_member",
      "not_agent_room",
      "harness_mode",
      "calls_disabled",
    ]) {
      const s = setup({ membership: { allowed: false, reason } });
      const response = await s.handle(tokenRequest());
      expect(response.status).toBe(403);
      // treaty livekit-token.v1, 403: matrix-error.v1 with the plan's copy and C4's reason.
      expect(await response.json()).toEqual({
        errcode: "M_FORBIDDEN",
        error: "Calls are not available for this agent yet",
        reason,
      });
    }
  });

  test("an OpenID token the homeserver does not accept is 401, and the hub is not asked", async () => {
    const s = setup({ user: null });
    const response = await s.handle(tokenRequest());
    expect(response.status).toBe(401);
    expect((await json(response)).errcode).toBe("M_UNAUTHORIZED");
    expect(s.checked).toEqual([]);
  });

  test("an upstream that cannot answer is 503, never an answer", async () => {
    for (const options of [
      { homeserverDown: true as const },
      { membership: "throw" as const },
    ]) {
      const s = setup(options);
      const response = await s.handle(tokenRequest());
      expect(response.status).toBe(503);
      const body = await json(response);
      expect(body.errcode).toBe("M_UNKNOWN");
      expect(body).not.toHaveProperty("jwt");
    }
  });

  test("a body that is not a token request is 400, checked before anybody is asked", async () => {
    const cases: Array<[Request, string]> = [
      [post("/v1/token", "not json"), "M_BAD_JSON"],
      [post("/v1/token", "[]"), "M_BAD_JSON"],
      [tokenRequest({ room_id: "not-a-room" }), "M_INVALID_PARAM"],
      [tokenRequest({ room_id: undefined }), "M_INVALID_PARAM"],
      [tokenRequest({ device_id: "" }), "M_INVALID_PARAM"],
      [tokenRequest({ device_id: "A B" }), "M_INVALID_PARAM"],
      [tokenRequest({ openid_token: undefined }), "M_INVALID_PARAM"],
      // treaty livekit-token.v1's invalid requests.
      [tokenRequest({ room_id: "call:example.org" }), "M_INVALID_PARAM"],
      [
        tokenRequest({
          openid_token: { ...OPENID, matrix_server_name: undefined },
        }),
        "M_INVALID_PARAM",
      ],
      [
        tokenRequest({ openid_token: { ...OPENID, access_token: "" } }),
        "M_INVALID_PARAM",
      ],
    ];
    for (const [request, errcode] of cases) {
      const s = setup();
      const response = await s.handle(request);
      expect(response.status).toBe(400);
      expect((await json(response)).errcode).toBe(errcode);
      expect(s.verified).toEqual([]);
    }
  });

  test("a body over 16 KiB is 413, a GET is 405", async () => {
    const s = setup();
    const big = await s.handle(
      tokenRequest({ padding: "x".repeat(17 * 1024) }),
    );
    expect(big.status).toBe(413);
    const get = await s.handle(new Request("http://exchange/v1/token"));
    expect(get.status).toBe(405);
  });

  test("with the token service off, its routes are not there", async () => {
    const s = setup({ superdial: false });
    for (const request of [
      tokenRequest(),
      leaveRequest(),
      post("/v1/livekit-webhook", "{}"),
    ]) {
      expect((await s.handle(request)).status).toBe(404);
    }
  });
});

describe("POST /v1/delayed-leave (C5)", () => {
  test("a caller's own device's delay is kept, under its LiveKit room and identity", async () => {
    const s = setup();
    const response = await s.handle(leaveRequest());
    expect(response.status).toBe(204);
    expect(s.registered).toEqual([
      {
        livekitRoom: livekitRoomName(ROOM),
        identity: "@p:s.example:DEV",
        userId: "@p:s.example",
        roomId: ROOM,
        delayId: "syd_secret_1",
      },
    ]);
    for (const line of s.lines) {
      expect(line).not.toContain("syd_secret_1");
      expect(line).not.toContain(ACCESS);
    }
  });

  test("a device that is not the caller's is refused", async () => {
    const s = setup({ devices: ["OTHER"] });
    const response = await s.handle(leaveRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      errcode: "M_FORBIDDEN",
      error: "The device is not the caller's",
      reason: "not_your_device",
    });
    expect(s.registered).toEqual([]);
  });

  test("a caller the hub does not allow into the call is refused with its reason", async () => {
    const s = setup({ membership: { allowed: false, reason: "not_member" } });
    const response = await s.handle(leaveRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      errcode: "M_FORBIDDEN",
      error: "Calls are not available for this agent yet",
      reason: "not_member",
    });
    expect(s.registered).toEqual([]);
  });

  test("a bad delay id is 400, a refused OpenID token 401, a device list that cannot be read 503", async () => {
    for (const bad of ["", "a b", 7, undefined]) {
      const s = setup();
      expect((await s.handle(leaveRequest({ delay_id: bad }))).status).toBe(
        400,
      );
    }
    expect((await setup({ user: null }).handle(leaveRequest())).status).toBe(
      401,
    );
    const down = setup({ devices: "throw" });
    expect((await down.handle(leaveRequest())).status).toBe(503);
    expect(down.registered).toEqual([]);
  });
});

describe("POST /v1/livekit-webhook (C5)", () => {
  const body = JSON.stringify({
    event: "participant_left",
    id: "EV_1",
    room: { name: "lkroom" },
    participant: { identity: "@p:s.example:DEV" },
  });

  test("a webhook LiveKit signed drives the loop", async () => {
    const s = setup();
    const response = await s.handle(
      post("/v1/livekit-webhook", body, {
        "content-type": "application/webhook+json",
        authorization: await signed(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(s.events).toEqual([
      {
        event: "participant_left",
        room: "lkroom",
        identity: "@p:s.example:DEV",
      },
    ]);
  });

  test("an unsigned, forged or altered webhook is 401 and changes nothing", async () => {
    const s = setup();
    const altered = body.replace("participant_left", "participant_joined");
    for (const request of [
      post("/v1/livekit-webhook", body),
      post("/v1/livekit-webhook", body, {
        authorization: await signed(body, "another-secret-0123456789abcdef"),
      }),
      post("/v1/livekit-webhook", altered, {
        authorization: await signed(body),
      }),
    ]) {
      expect((await s.handle(request)).status).toBe(401);
    }
    expect(s.events).toEqual([]);
  });
});
