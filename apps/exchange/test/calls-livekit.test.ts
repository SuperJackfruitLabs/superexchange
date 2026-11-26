import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AccessToken,
  ParticipantInfo,
  TokenVerifier,
  TwirpError,
} from "livekit-server-sdk";
import {
  CallUpstreamError,
  TOKEN_TTL_SECONDS,
  createLiveKit,
  isDelayId,
  isDeviceId,
  isRoomId,
  livekitIdentity,
  livekitRoomName,
} from "../src/calls/index.ts";

const KEY = "lk-key-for-tests";
const SECRET = "lk-secret-for-tests-0123456789abcdef";
const SETTINGS = {
  livekitUrl: "wss://lk.example",
  livekitApiUrl: "https://lk.example",
  livekitApiKey: KEY,
  livekitApiSecret: SECRET,
};

/** The Authorization header LiveKit signs a webhook body with. */
async function signed(body: string, secret = SECRET): Promise<string> {
  const token = new AccessToken(KEY, secret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return token.toJwt();
}

const webhook = (event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event,
    id: "EV_1",
    createdAt: "1764200000",
    room: { name: "lkroom" },
    participant: { identity: "@u:s:DEV" },
    ...extra,
  });

describe("calls: names (C5)", () => {
  test("the identity is the user id, a colon and the device id", () => {
    expect(livekitIdentity("@u:s", "DEV")).toBe("@u:s:DEV");
  });

  test("the LiveKit room is unpadded base64url of the room id's SHA-256", () => {
    expect(livekitRoomName("!abc:example.org")).toBe(
      "nvWwsW5F1fC-3OzBzN9V6HZBBcivAdVzCnEAGT1g7cU",
    );
    for (const roomId of ["!r:s", "!ü:s", "!a+b/c:example.org"]) {
      const name = livekitRoomName(roomId);
      expect(name).toBe(
        createHash("sha256").update(roomId, "utf8").digest("base64url"),
      );
      expect(name).not.toContain("=");
    }
  });

  test("ids are checked for their shape", () => {
    expect(isRoomId("!r:s")).toBe(true);
    expect(isRoomId("!r:s.example:8448")).toBe(true);
    // Room version 12 ids have no server part (treaty: "with or without a server part").
    expect(isRoomId("!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM")).toBe(true);
    for (const bad of [
      "r:s",
      "!",
      "! r:s",
      "!r\n:s",
      "",
      7,
      null,
      `!${"a".repeat(300)}:s`,
    ])
      expect(isRoomId(bad)).toBe(false);
    expect(isDeviceId("SUPERDIAL")).toBe(true);
    expect(isDelayId("syd_AbCdEf")).toBe(true);
    for (const bad of ["", "A B", "A\nB", 1, null, "x".repeat(256)]) {
      expect(isDeviceId(bad)).toBe(false);
      expect(isDelayId(bad)).toBe(false);
    }
    // The identity is {user_id}:{device_id}, split at its last colon (treaty's pattern).
    expect(isDeviceId("A:B")).toBe(false);
  });
});

describe("calls: the LiveKit adapter", () => {
  test("a token joins that room only, publishes and subscribes, briefly", async () => {
    const livekit = createLiveKit(SETTINGS);
    expect(livekit.url).toBe("wss://lk.example");
    const jwt = await livekit.mint("@u:s:DEV", "@u:s", "lkroom");
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.sub).toBe("@u:s:DEV");
    expect(claims.name).toBe("@u:s");
    expect(claims.video).toEqual({
      roomJoin: true,
      room: "lkroom",
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });
    expect((claims.exp ?? Infinity) - (claims.nbf ?? 0)).toBeLessThanOrEqual(
      TOKEN_TTL_SECONDS,
    );
    expect(TOKEN_TTL_SECONDS).toBeLessThanOrEqual(600);
    // Signed with this key's secret, so another secret cannot read it as genuine.
    const forged = await new TokenVerifier(
      KEY,
      "another-secret-0123456789abcdef",
    )
      .verify(jwt)
      .then(
        () => "read",
        () => "refused",
      );
    expect(forged).toBe("refused");
  });

  test("a webhook signed with the secret is read", async () => {
    const livekit = createLiveKit(SETTINGS);
    const body = webhook("participant_left");
    expect(await livekit.receive(body, await signed(body))).toEqual({
      event: "participant_left",
      room: "lkroom",
      identity: "@u:s:DEV",
    });
    const finished = webhook("room_finished", { participant: undefined });
    expect(await livekit.receive(finished, await signed(finished))).toEqual({
      event: "room_finished",
      room: "lkroom",
      identity: null,
    });
  });

  test("a forged, altered or unsigned webhook is not read", async () => {
    const livekit = createLiveKit(SETTINGS);
    const body = webhook("participant_left");
    expect(
      await livekit.receive(
        body,
        await signed(body, "another-secret-0123456789abcdef"),
      ),
    ).toBeNull();
    expect(
      await livekit.receive(webhook("participant_joined"), await signed(body)),
    ).toBeNull();
    expect(await livekit.receive(body, null)).toBeNull();
    expect(await livekit.receive(body, "")).toBeNull();
    expect(
      await livekit.receive("not json", await signed("not json")),
    ).toBeNull();
  });

  test("presence: found is connected, not_found is not, anything else is unknown", async () => {
    const asked: Array<[string, string]> = [];
    const present = createLiveKit(SETTINGS, {
      rooms: {
        getParticipant: (room, identity) => {
          asked.push([room, identity]);
          return Promise.resolve(new ParticipantInfo({ identity }));
        },
      },
    });
    expect(await present.isConnected("lkroom", "@u:s:DEV")).toBe(true);
    expect(asked).toEqual([["lkroom", "@u:s:DEV"]]);

    const absent = createLiveKit(SETTINGS, {
      rooms: {
        getParticipant: () =>
          Promise.reject(
            new TwirpError(
              "TwirpError",
              "participant not found",
              404,
              "not_found",
            ),
          ),
      },
    });
    expect(await absent.isConnected("lkroom", "@u:s:DEV")).toBe(false);

    const down = createLiveKit(SETTINGS, {
      rooms: {
        getParticipant: () =>
          Promise.reject(new Error(`fetch ${SECRET} failed`)),
      },
    });
    const error = await down
      .isConnected("lkroom", "@u:s:DEV")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallUpstreamError);
    expect(String(error)).not.toContain(SECRET);
    expect(error instanceof Error && error.cause).toBeUndefined();
  });
});
