import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  OlmMachine,
  RoomId,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import {
  CryptoError,
  createClient,
  createCryptoTransport,
  createSpeakerCrypto,
  cryptoTransactionOf,
  hasCryptoChanges,
  type SpeakerCrypto,
} from "../src/appservice/index.ts";
import {
  noOlmRecipients,
  ownParts,
  speakerKeyCounts,
} from "../src/appservice/crypto.ts";
import {
  closeTrackedMachine,
  openMachineCount,
  trackOpenMachine,
} from "../src/appservice/open-machines.ts";
import { captureLog, tempStore } from "./helpers.ts";

/**
 * The real Rust machine, twice: the speaker through this service's crypto layer, and a person's
 * device driven directly, both talking to an in-memory key server. Nothing is faked but the
 * homeserver.
 */

const SERVER = "staging-matrix.example.test";
const SPEAKER = `@superexchange_board:${SERVER}`;
const ANA = `@ana:${SERVER}`;
const ANA_DEVICE = "ANADEVICE";
const ROOM = `!board:${SERVER}`;
const AS_TOKEN = "as-token-for-crypto-tests";
const PASSPHRASE = "crypto-passphrase-for-tests-0123456789";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Json = Record<string, any>;

/** Just enough of a homeserver's key endpoints for two devices to talk. */
function keyServer() {
  const devices = new Map<string, Map<string, Json>>();
  const otks = new Map<string, Map<string, unknown>>();
  const fallbacks = new Map<string, Map<string, unknown>>();
  const crossSigning = new Map<string, Json>();
  const inbox = new Map<string, Json[]>();
  const logins: string[] = [];
  let issued = 0;

  const slot = (user: string, device: string) => `${user}|${device}`;
  const count = (user: string, device: string) => {
    const counts: Record<string, number> = {};
    for (const id of otks.get(slot(user, device))?.keys() ?? []) {
      const alg = id.split(":")[0] as string;
      counts[alg] = (counts[alg] ?? 0) + 1;
    }
    return counts;
  };

  function serve(
    method: string,
    path: string,
    user: string,
    device: string,
    body: Json,
  ): { status: number; json: Json } {
    const ok = (json: Json) => ({ status: 200, json });
    if (path === "/_matrix/client/v3/register")
      return { status: 400, json: { errcode: "M_USER_IN_USE" } };
    if (path === "/_matrix/client/v3/login") {
      logins.push(String(body.identifier?.user));
      return ok({
        device_id: `SPEAKER${++issued}`,
        access_token: "dropped-token",
        user_id: SPEAKER,
      });
    }
    if (path === "/_matrix/client/v3/keys/upload") {
      if (body.device_keys) {
        const mine = devices.get(user) ?? new Map();
        mine.set(device, body.device_keys);
        devices.set(user, mine);
      }
      const pool = otks.get(slot(user, device)) ?? new Map();
      for (const [id, key] of Object.entries(body.one_time_keys ?? {}))
        pool.set(id, key);
      otks.set(slot(user, device), pool);
      if (body.fallback_keys)
        fallbacks.set(
          slot(user, device),
          new Map(Object.entries(body.fallback_keys)),
        );
      return ok({ one_time_key_counts: count(user, device) });
    }
    if (path === "/_matrix/client/v3/keys/query") {
      const device_keys: Json = {};
      const master_keys: Json = {};
      const self_signing_keys: Json = {};
      const user_signing_keys: Json = {};
      for (const who of Object.keys(body.device_keys ?? {})) {
        device_keys[who] = Object.fromEntries(devices.get(who) ?? new Map());
        const cs = crossSigning.get(who);
        if (cs?.master_key) master_keys[who] = cs.master_key;
        if (cs?.self_signing_key) self_signing_keys[who] = cs.self_signing_key;
        if (cs?.user_signing_key && who === user)
          user_signing_keys[who] = cs.user_signing_key;
      }
      return ok({
        device_keys,
        failures: {},
        master_keys,
        self_signing_keys,
        user_signing_keys,
      });
    }
    if (path === "/_matrix/client/v3/keys/claim") {
      const one_time_keys: Json = {};
      for (const [who, wanted] of Object.entries(body.one_time_keys ?? {})) {
        for (const [dev, alg] of Object.entries(wanted as Json)) {
          const pool = otks.get(slot(who, dev));
          let id = [...(pool?.keys() ?? [])].find((k) =>
            k.startsWith(`${String(alg)}:`),
          );
          let key: unknown;
          if (id !== undefined) {
            key = pool?.get(id);
            pool?.delete(id);
          } else {
            const fb = fallbacks.get(slot(who, dev));
            id = [...(fb?.keys() ?? [])][0];
            key = id === undefined ? undefined : fb?.get(id);
          }
          if (id === undefined) continue;
          one_time_keys[who] ??= {};
          one_time_keys[who][dev] = { [id]: key };
        }
      }
      return ok({ one_time_keys, failures: {} });
    }
    if (path === "/_matrix/client/v3/keys/device_signing/upload") {
      crossSigning.set(user, { ...crossSigning.get(user), ...body });
      return ok({});
    }
    if (path === "/_matrix/client/v3/keys/signatures/upload")
      return ok({ failures: {} });
    const toDevice =
      /^\/_matrix\/client\/v3\/sendToDevice\/([^/]+)\/[^/]+$/.exec(path);
    if (toDevice) {
      const type = decodeURIComponent(toDevice[1] as string);
      for (const [who, perDevice] of Object.entries(body.messages ?? {})) {
        for (const [dev, content] of Object.entries(perDevice as Json)) {
          const targets =
            dev === "*" ? [...(devices.get(who)?.keys() ?? [])] : [dev];
          for (const target of targets) {
            const box = inbox.get(slot(who, target)) ?? [];
            box.push({ type, sender: user, content });
            inbox.set(slot(who, target), box);
          }
        }
      }
      return ok({});
    }
    return { status: 404, json: { errcode: "M_UNRECOGNIZED" } };
  }

  const calls: Array<{
    path: string;
    userId: string | null;
    deviceId: string | null;
    auth: string | null;
  }> = [];
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push({
      path,
      userId: url.searchParams.get("user_id"),
      deviceId: url.searchParams.get("device_id"),
      auth: new Headers(init?.headers).get("authorization"),
    });
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    const { status, json } = serve(
      init?.method ?? "GET",
      path,
      url.searchParams.get("user_id") ?? "",
      url.searchParams.get("device_id") ?? "",
      body,
    );
    return Response.json(json, { status });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    serve,
    calls,
    logins,
    /** Take every to-device event waiting for a device. */
    drain(user: string, device: string): Json[] {
      const box = inbox.get(slot(user, device)) ?? [];
      inbox.delete(slot(user, device));
      return box;
    },
    count,
  };
}

/** A person's device, the real machine, its requests carried straight to the key server. */
async function personDevice(hs: ReturnType<typeof keyServer>) {
  const machine = await OlmMachine.initialize(
    new UserId(ANA),
    new DeviceId(ANA_DEVICE),
  );
  trackOpenMachine(machine);
  cleanups.push(() => closeTrackedMachine(machine));
  const carry = async (
    r: { id: string; type?: number; body: string; eventType?: string },
    type: number,
  ) => {
    const body = JSON.parse(r.body) as Json;
    const path = {
      0: "/_matrix/client/v3/keys/upload",
      1: "/_matrix/client/v3/keys/query",
      2: "/_matrix/client/v3/keys/claim",
      3: `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType ?? "")}/t`,
      4: "/_matrix/client/v3/keys/signatures/upload",
    }[type] as string;
    const answer = hs.serve("POST", path, ANA, ANA_DEVICE, body);
    await machine.markRequestAsSent(r.id, type, JSON.stringify(answer.json));
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      const requests = await machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const r of requests)
        await carry(r, (r as unknown as { type: number }).type);
    }
  };
  await flush();
  return {
    machine,
    flush,
    /** Take the room keys and olm traffic waiting for this device. */
    async sync() {
      await machine.receiveSyncChanges(
        JSON.stringify(hs.drain(ANA, ANA_DEVICE)),
        new DeviceLists([], []),
        {},
        [],
      );
      await flush();
    },
    /** Encrypt a message into the room, sharing the room key with the speaker first. */
    async say(content: Json) {
      const members = [new UserId(ANA), new UserId(SPEAKER)];
      await machine.updateTrackedUsers(members);
      await flush();
      const missing = await machine.getMissingSessions(members);
      if (missing) await carry(missing, 2);
      for (const share of await machine.shareRoomKey(
        new RoomId(ROOM),
        members,
        new EncryptionSettings(),
      ))
        await carry(share, 3);
      return JSON.parse(
        await machine.encryptRoomEvent(
          new RoomId(ROOM),
          "m.room.message",
          JSON.stringify(content),
        ),
      ) as Json;
    },
  };
}

function speakerFor(
  hs: ReturnType<typeof keyServer>,
  dataDir: string,
  given?: ReturnType<typeof tempStore>["store"],
  passphrase = PASSPHRASE,
) {
  let store = given;
  if (store === undefined) {
    const t = tempStore();
    cleanups.push(t.cleanup);
    store = t.store;
  }
  const { log, lines } = captureLog();
  const client = createClient({
    homeserverUrl: "http://homeserver.test",
    serverName: SERVER,
    asToken: AS_TOKEN,
    fetch: hs.fetch,
  });
  const crypto = createSpeakerCrypto({
    userId: SPEAKER,
    storeDir: join(dataDir, "crypto"),
    passphrase,
    store,
    client,
    transport: createCryptoTransport({
      homeserverUrl: "http://homeserver.test",
      asToken: AS_TOKEN,
      fetch: hs.fetch,
    }),
    log,
  });
  cleanups.push(() => crypto.close());
  return { crypto, store, lines };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "superexchange-crypto-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The speaker's to-device events, handed over as a transaction would. */
async function speakerSync(
  hs: ReturnType<typeof keyServer>,
  crypto: SpeakerCrypto,
  store: { cryptoDevice(u: string): string | null },
) {
  const device = store.cryptoDevice(SPEAKER) ?? "";
  await crypto.receive(
    cryptoTransactionOf({
      "de.sorunome.msc2409.to_device": hs.drain(SPEAKER, device),
      "org.matrix.msc3202.device_one_time_keys_count": {
        [SPEAKER]: { [device]: hs.count(SPEAKER, device) },
      },
    }),
  );
}

const asEvent = (sender: string, content: Json, eventId: string) => ({
  type: "m.room.encrypted",
  sender,
  room_id: ROOM,
  event_id: eventId,
  origin_server_ts: 1,
  content,
});

describe("the speaker's encryption, with the real machine", () => {
  test("a gate the speaker encrypts is read by a person's device", async () => {
    const hs = keyServer();
    const t = tempStore();
    cleanups.push(t.cleanup);
    const { crypto } = speakerFor(hs, tempDir(), t.store);
    const ana = await personDevice(hs);
    await crypto.start();

    const content = { msgtype: "m.text", body: "Approve the release?" };
    const envelope = await crypto.encrypt(
      ROOM,
      [SPEAKER, ANA],
      "m.room.message",
      content,
    );
    expect(envelope.algorithm).toBe("m.megolm.v1.aes-sha2");
    expect(JSON.stringify(envelope)).not.toContain("Approve the release");

    await ana.sync();
    const read = await ana.machine.decryptRoomEvent(
      JSON.stringify(asEvent(SPEAKER, envelope, "$gate")),
      new RoomId(ROOM),
    );
    expect(JSON.parse(read.event)).toMatchObject({
      type: "m.room.message",
      content,
    });
    // Every crypto request named the speaker and its one device, with the as_token.
    const cryptoCalls = hs.calls.filter(
      (c) => c.path.includes("/keys/") || c.path.includes("sendToDevice"),
    );
    expect(cryptoCalls.length).toBeGreaterThan(0);
    for (const c of cryptoCalls) {
      expect(c.userId).toBe(SPEAKER);
      expect(c.deviceId).toBe(t.store.cryptoDevice(SPEAKER));
      expect(c.auth).toBe(`Bearer ${AS_TOKEN}`);
    }
  });

  test("a person's answer that arrives before its key decrypts once the key does", async () => {
    const hs = keyServer();
    const t = tempStore();
    cleanups.push(t.cleanup);
    const { crypto } = speakerFor(hs, tempDir(), t.store);
    await crypto.start();
    const ana = await personDevice(hs);

    const answer = { msgtype: "m.text", body: "Approve" };
    const event = asEvent(ANA, await ana.say(answer), "$answer");
    // The room key is still in the to-device queue: not yet.
    expect(await crypto.decrypt(event)).toBeNull();
    await speakerSync(hs, crypto, t.store);
    expect(await crypto.decrypt(event)).toEqual({
      type: "m.room.message",
      content: answer,
    });
  });

  test("a restart reuses the recorded device and its keys: no second login", async () => {
    const hs = keyServer();
    const dir = tempDir();
    const t = tempStore();
    cleanups.push(t.cleanup);
    const first = speakerFor(hs, dir, t.store);
    await first.crypto.start();
    const ana = await personDevice(hs);
    const event = asEvent(ANA, await ana.say({ body: "Approve" }), "$a1");
    await speakerSync(hs, first.crypto, t.store);
    const device = t.store.cryptoDevice(SPEAKER);
    expect(device).toBe("SPEAKER1");
    await first.crypto.close();

    const again = speakerFor(hs, dir, t.store);
    await again.crypto.start();
    expect(hs.logins).toEqual(["superexchange_board"]);
    expect(t.store.cryptoDevice(SPEAKER)).toBe(device);
    expect(await again.crypto.decrypt(event)).toMatchObject({
      content: { body: "Approve" },
    });
  });

  test("a wrong passphrase is refused, and the error does not carry it", async () => {
    const hs = keyServer();
    const dir = tempDir();
    const t = tempStore();
    cleanups.push(t.cleanup);
    const first = speakerFor(hs, dir, t.store);
    await first.crypto.start();
    await first.crypto.close();

    const wrong = "a-different-passphrase-0123456789abcdef";
    const again = speakerFor(hs, dir, t.store, wrong);
    let error: unknown = null;
    try {
      await again.crypto.start();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CryptoError);
    expect(String((error as Error).message)).not.toContain(wrong);
    expect(String((error as Error).message)).not.toContain(dir);
    expect(again.lines.join("\n")).not.toContain(wrong);
  });

  test("a store that is gone with its device on record takes a new device", async () => {
    const hs = keyServer();
    const dir = tempDir();
    const t = tempStore();
    cleanups.push(t.cleanup);
    const first = speakerFor(hs, dir, t.store);
    await first.crypto.start();
    await first.crypto.close();
    rmSync(join(dir, "crypto"), { recursive: true, force: true });

    const again = speakerFor(hs, dir, t.store);
    await again.crypto.start();
    expect(hs.logins).toHaveLength(2);
    expect(t.store.cryptoDevice(SPEAKER)).toBe("SPEAKER2");
    expect(again.lines).toContain(
      "appservice: the speaker's crypto store is missing, so its recorded device cannot be used; a new device is taken",
    );
  });

  test("a store with no device on record is moved aside, never deleted", async () => {
    const hs = keyServer();
    const dir = tempDir();
    const first = speakerFor(hs, dir);
    await first.crypto.start();
    await first.crypto.close();

    const fresh = tempStore();
    cleanups.push(fresh.cleanup);
    const again = speakerFor(hs, dir, fresh.store);
    await again.crypto.start();
    const kept = readdirSync(join(dir, "crypto"));
    expect(
      kept.some((n) => n.startsWith("superexchange_board.unrecorded-")),
    ).toBe(true);
    expect(existsSync(join(dir, "crypto", "superexchange_board"))).toBe(true);
  });

  test("it refuses to encrypt to nobody but the speaker", async () => {
    const hs = keyServer();
    const { crypto } = speakerFor(hs, tempDir());
    await expect(
      crypto.encrypt(ROOM, [SPEAKER], "m.room.message", { body: "x" }),
    ).rejects.toThrow("refusing to encrypt to nobody but the speaker");
  });

  test("close leaves no machine open", async () => {
    const hs = keyServer();
    const before = openMachineCount();
    const { crypto } = speakerFor(hs, tempDir());
    await crypto.start();
    expect(openMachineCount()).toBe(before + 1);
    await crypto.close();
    expect(openMachineCount()).toBe(before);
  });
});

describe("the crypto parts of a transaction", () => {
  test("are read under their unstable names first, then the stable ones", () => {
    const tx = cryptoTransactionOf({
      "de.sorunome.msc2409.to_device": [{ type: "m.room_key" }],
      to_device: [{ type: "ignored" }],
      "org.matrix.msc3202.device_lists": { changed: [ANA, 7], left: [] },
      device_one_time_keys_count: {
        [SPEAKER]: { D: { signed_curve25519: 3 } },
      },
    });
    expect(tx).toEqual({
      toDevice: [{ type: "m.room_key" }],
      deviceLists: { changed: [ANA], left: [] },
      otkCounts: { [SPEAKER]: { D: { signed_curve25519: 3 } } },
      unusedFallbackKeys: {},
    });
    expect(hasCryptoChanges(tx)).toBe(true);
    expect(hasCryptoChanges(cryptoTransactionOf({ events: [] }))).toBe(false);
    expect(hasCryptoChanges(cryptoTransactionOf(null))).toBe(false);
  });
});

describe("the speaker's key counts", () => {
  test("are the speaker's own, never another namespace user's", () => {
    const tx = cryptoTransactionOf({
      "org.matrix.msc3202.device_one_time_keys_count": {
        [`@superexchange_other:${SERVER}`]: { D: { signed_curve25519: 0 } },
        [SPEAKER]: { DEV1: { signed_curve25519: 42 } },
      },
      "org.matrix.msc3202.device_unused_fallback_key_types": {
        [`@superexchange_other:${SERVER}`]: { D: ["other_alg"] },
        [SPEAKER]: { DEV1: ["signed_curve25519"] },
      },
    });
    expect(speakerKeyCounts(tx, SPEAKER)).toEqual({
      otk: { signed_curve25519: 42 },
      fallback: ["signed_curve25519"],
    });
    expect(speakerKeyCounts(tx, `@superexchange_nobody:${SERVER}`)).toEqual({
      otk: {},
      fallback: [],
    });
  });
});

describe("a decrypted event's own parts", () => {
  test("are its type and content; nothing in the plaintext says who sent it or where", () => {
    expect(
      ownParts(
        JSON.stringify({
          type: "m.room.message",
          content: { body: "hi" },
          sender: "@mallory:x",
          event_id: "$forged",
          room_id: ROOM,
        }),
        ROOM,
      ),
    ).toEqual({ type: "m.room.message", content: { body: "hi" } });
  });

  test("a plaintext naming another room, or with no content, is not this room's event", () => {
    expect(
      ownParts(
        JSON.stringify({ type: "m", content: {}, room_id: "!other:x" }),
        ROOM,
      ),
    ).toBeNull();
    expect(ownParts(JSON.stringify({ type: "m" }), ROOM)).toBeNull();
    expect(ownParts("not json", ROOM)).toBeNull();
  });
});

describe("withheld room keys", () => {
  test("the owners of devices that refused an olm session are named", () => {
    expect(
      noOlmRecipients([
        { eventType: "m.room.encrypted", body: "{}" },
        {
          eventType: "m.room_key.withheld",
          body: JSON.stringify({
            messages: {
              [ANA]: { D1: { code: "m.no_olm" } },
              "@bo:x": { D2: { code: "m.unverified" } },
            },
          }),
        },
        { eventType: "m.room_key.withheld", body: "not json" },
      ]),
    ).toEqual([ANA]);
  });
});
