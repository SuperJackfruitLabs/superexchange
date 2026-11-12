/**
 * End-to-end encryption for the board speaker: SuperExchange's own keys for the board rooms it
 * speaks in (charter, `decisions/2026-11-10-superexchange-owns-the-communication-server.md`,
 * decision 2).
 *
 * Ported from the AgentPod hub's `services/matrix-as/crypto.ts`, narrowed to one user: the
 * speaker `@superexchange_board`. `@matrix-org/matrix-sdk-crypto-nodejs` is the Rust state
 * machine and performs no network IO: it is fed what arrived, and hands back requests for
 * `crypto-transport.ts` to carry.
 *
 *     transaction ─▶ receive() ─▶ machine.receiveSyncChanges() ─▶ outgoingRequests() ─▶ homeserver
 *
 * - **The device.** Taken once from an appservice login (`m.login.application_service`) and
 *   recorded in the store, so every start reuses it: a device per boot would leave a trail of
 *   abandoned devices every client must still encrypt to, and throw away every room key the
 *   speaker had been given. The access token that comes with it is dropped.
 * - **The keys.** An on-disk store per user under `<data dir>/crypto/<localpart>`, encrypted with
 *   `SUPEREXCHANGE_CRYPTO_PASSPHRASE`. It is as load-bearing as the database beside it: lose it
 *   and the speaker loses every key it holds, unrecoverably. A store that is gone while its
 *   device is still on record cannot be used with that device (its new keys would not match the
 *   ones uploaded), so a new device is taken; a store left without a recorded device is moved
 *   aside, never deleted.
 * - **The homeserver.** The registration needs `de.sorunome.msc2409.push_ephemeral` and
 *   `org.matrix.msc3202` for to-device events, device-list changes and one-time-key counts to
 *   arrive in transactions, and `io.element.msc4190` off, which turns appservice login off.
 *
 * The binding is loaded only when a machine is first built, so a plaintext deployment never
 * loads it. One operation runs against the machine at a time: two drains of its outbox at once
 * would send the same request twice.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type {
  DecryptedRoomEvent,
  OlmMachine,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { Store } from "../store/index.ts";
import type { AppserviceClient } from "./client.ts";
import {
  REQUEST_TYPE,
  type CryptoRequest,
  type CryptoTransport,
} from "./crypto-transport.ts";
import { closeTrackedMachine, trackOpenMachine } from "./open-machines.ts";
import type { MatrixEvent } from "./transactions.ts";

/** The binding's `StoreType.Sqlite`, by number (an ambient const enum). */
const SQLITE_STORE = 0;

/** The event type an encrypted room event travels as. */
export const ENCRYPTED_EVENT_TYPE = "m.room.encrypted";

/**
 * The crypto parts of an appservice transaction, for the whole namespace.
 *
 * MSC2409 and MSC3202: the only way an appservice learns of olm traffic, device changes and its
 * own key counts; there is no `/sync` to read them from.
 */
export interface CryptoTransaction {
  /** To-device events: olm key exchange, room keys. */
  toDevice: unknown[];
  /** Whose devices changed, and who left. Flat, as in `/sync`. */
  deviceLists: { changed: string[]; left: string[] };
  /** One-time keys left, by user, then device, then algorithm. */
  otkCounts: Record<string, Record<string, Record<string, number>>>;
  /** Algorithms with no unused fallback key, by user, then device. */
  unusedFallbackKeys: Record<string, Record<string, string[]>>;
}

/**
 * The unstable name each field arrives under. MSC3202 and MSC4203 are unstable, so the
 * homeserver prefixes them; the hub first read the stable names, which nothing sends, and
 * received no room keys at all while every transaction parsed. Both are read, the unstable first.
 */
const UNSTABLE = {
  to_device: "de.sorunome.msc2409.to_device",
  device_lists: "org.matrix.msc3202.device_lists",
  device_one_time_keys_count: "org.matrix.msc3202.device_one_time_keys_count",
  device_unused_fallback_key_types:
    "org.matrix.msc3202.device_unused_fallback_key_types",
} as const;

/** A transaction body's crypto parts, under either name; empty where absent or malformed. */
export function cryptoTransactionOf(body: unknown): CryptoTransaction {
  const b = isRecord(body) ? body : {};
  const field = (name: keyof typeof UNSTABLE): unknown =>
    b[UNSTABLE[name]] ?? b[name];
  const toDevice = field("to_device");
  const lists = field("device_lists");
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const otk = field("device_one_time_keys_count");
  const fallback = field("device_unused_fallback_key_types");
  return {
    toDevice: Array.isArray(toDevice) ? toDevice : [],
    deviceLists: {
      changed: strings(isRecord(lists) ? lists.changed : undefined),
      left: strings(isRecord(lists) ? lists.left : undefined),
    },
    otkCounts: isRecord(otk) ? (otk as CryptoTransaction["otkCounts"]) : {},
    unusedFallbackKeys: isRecord(fallback)
      ? (fallback as CryptoTransaction["unusedFallbackKeys"])
      : {},
  };
}

/** Does a transaction carry anything for a machine? */
export function hasCryptoChanges(tx: CryptoTransaction): boolean {
  return (
    tx.toDevice.length > 0 ||
    tx.deviceLists.changed.length > 0 ||
    tx.deviceLists.left.length > 0 ||
    Object.keys(tx.otkCounts).length > 0 ||
    Object.keys(tx.unusedFallbackKeys).length > 0
  );
}

/** A decrypted room event's own parts. Who sent it, where and when stay the envelope's. */
export interface DecryptedEvent {
  type: string;
  content: Record<string, unknown>;
}

/** What board chat needs: encrypting into a room, and decrypting from one. */
export interface RoomCrypto {
  /**
   * Encrypt content for a room. `members` is everyone the room key is shared with, the speaker
   * included; a member missing from it cannot read the result. Throws rather than encrypt to
   * nobody but the speaker.
   */
  encrypt(
    roomId: string,
    members: string[],
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * Decrypt an `m.room.encrypted` event: null when its key is not here (yet), or it does not
   * decrypt to an event of that room. Throws only when the machine itself cannot be used.
   */
  decrypt(event: MatrixEvent): Promise<DecryptedEvent | null>;
}

export interface SpeakerCrypto extends RoomCrypto {
  /** Build the machine now: its device and keys published before anybody needs them. */
  start(): Promise<void>;
  /** Feed a transaction's crypto parts to the machine, and send what it asks for. */
  receive(tx: CryptoTransaction): Promise<void>;
  /** Close the machine. Awaited: a machine left open at exit aborts the process. */
  close(): Promise<void>;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export interface SpeakerCryptoDeps {
  /** The speaker's Matrix id. */
  userId: string;
  /** The directory every user's crypto store lives under (`<data dir>/crypto`). */
  storeDir: string;
  /** `SUPEREXCHANGE_CRYPTO_PASSPHRASE`: the store's encryption key. Never logged. */
  passphrase: string;
  store: Pick<
    Store,
    "cryptoDevice" | "recordCryptoDevice" | "forgetCryptoDevice"
  >;
  client: Pick<AppserviceClient, "register" | "login">;
  transport: CryptoTransport;
  log: (line: string) => void;
  /** How long a device that refused a session is left alone, per room. */
  staleRetryCooldownMs?: number;
  now?: () => number;
}

/** How long a device that keeps refusing an olm session is left alone (the hub's ten minutes). */
export const STALE_RETRY_COOLDOWN_MS = 10 * 60_000;

/** The most passes an outbox drain takes before it is called stuck. */
const MAX_FLUSH_PASSES = 10;

type Binding = typeof import("@matrix-org/matrix-sdk-crypto-nodejs");

export function createSpeakerCrypto(deps: SpeakerCryptoDeps): SpeakerCrypto {
  const { userId, log } = deps;
  const localpart = userId.slice(1).split(":")[0] ?? "";
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.staleRetryCooldownMs ?? STALE_RETRY_COOLDOWN_MS;
  const staleTried = new Map<string, number>();

  let binding: Binding | null = null;
  let built: Promise<{ machine: OlmMachine; deviceId: string }> | null = null;
  let lock: Promise<unknown> = Promise.resolve();

  /** One operation against the machine at a time, in call order. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = lock.then(work);
    lock = run.catch(() => undefined);
    return run;
  }

  /** The device on record, made by an appservice login the first time. */
  async function deviceFor(dir: string): Promise<string> {
    const held = existsSync(dir) && readdirSync(dir).length > 0;
    let deviceId = deps.store.cryptoDevice(userId);
    if (deviceId !== null && !held) {
      // Keys made now would not match the ones that device already uploaded.
      log(
        "appservice: the speaker's crypto store is missing, so its recorded device cannot be used; a new device is taken",
      );
      deps.store.forgetCryptoDevice(userId);
      deviceId = null;
    }
    if (deviceId === null && held) {
      // Keys for a device nobody recorded: kept, moved aside, never deleted.
      const aside = `${dir}.unrecorded-${now()}`;
      renameSync(dir, aside);
      log(
        "appservice: the speaker's crypto store belonged to no recorded device; it was moved aside",
      );
    }
    if (deviceId !== null) return deviceId;
    await deps.client.register(localpart);
    const { deviceId: issued } = await deps.client.login(localpart);
    const recorded = deps.store.recordCryptoDevice(userId, issued);
    log("appservice: the speaker's encryption device was made");
    return recorded;
  }

  function machine(): Promise<{ machine: OlmMachine; deviceId: string }> {
    built ??= (async () => {
      binding ??= await import("@matrix-org/matrix-sdk-crypto-nodejs");
      const dir = join(deps.storeDir, localpart);
      const deviceId = await deviceFor(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      let m: OlmMachine;
      try {
        m = await binding.OlmMachine.initialize(
          new binding.UserId(userId),
          new binding.DeviceId(deviceId),
          dir,
          deps.passphrase,
          SQLITE_STORE,
        );
      } catch {
        // The binding's message may name the path; only what it means is said.
        throw new CryptoError(
          "the speaker's crypto store cannot be opened: a wrong SUPEREXCHANGE_CRYPTO_PASSPHRASE, or a damaged store",
        );
      }
      // Tracked before anything else can throw: a machine that failed to publish is still open.
      trackOpenMachine(m);
      try {
        await publishIdentity(m, deviceId);
        await flush(m, deviceId);
      } catch (error) {
        closeTrackedMachine(m);
        throw error;
      }
      return { machine: m, deviceId };
    })().catch((error: unknown) => {
      built = null;
      throw error;
    });
    return built;
  }

  async function sendRequest(
    deviceId: string,
    request: CryptoRequest,
  ): Promise<string> {
    return deps.transport.send(userId, deviceId, request);
  }

  /**
   * A cross-signing identity, published once, then the device's keys, then the signature that
   * says the device is the speaker's (the hub's `publishIdentity`, in its load-bearing order: the
   * homeserver waives user-interactive auth on the signing-key upload only while the account has
   * uploaded nothing). Not needed for keys to be delivered; it lets a person verify the speaker.
   * A refused identity is logged and the device's keys go up regardless.
   */
  async function publishIdentity(m: OlmMachine, deviceId: string) {
    const status = await m.crossSigningStatus();
    const held =
      status.hasMaster && status.hasSelfSigning && status.hasUserSigning;
    const reqs = await m.bootstrapCrossSigning(false);
    if (!held) {
      try {
        await deps.transport.uploadSigningKeys(
          userId,
          deviceId,
          reqs.uploadSigningKeysReq,
        );
      } catch (error) {
        log(
          `appservice: the speaker's cross-signing identity was not published (${describe(error)})`,
        );
      }
    }
    const upload = reqs.uploadKeysReq as unknown as CryptoRequest | undefined;
    if (upload) {
      const answer = await sendRequest(deviceId, {
        ...plain(upload),
        type: REQUEST_TYPE.KeysUpload,
      });
      await m.markRequestAsSent(upload.id, REQUEST_TYPE.KeysUpload, answer);
    }
    const signatures = reqs.uploadSignaturesReq as unknown as
      | CryptoRequest
      | undefined;
    if (signatures) {
      const answer = await sendRequest(deviceId, {
        ...plain(signatures),
        type: REQUEST_TYPE.SignatureUpload,
      });
      await m.markRequestAsSent(
        signatures.id,
        REQUEST_TYPE.SignatureUpload,
        answer,
      );
    }
  }

  /**
   * Drain the outbox until it is empty: one request routinely produces the next (a keys/query
   * answers with devices that need a keys/claim), and draining once leaves the last step undone.
   */
  async function flush(m: OlmMachine, deviceId: string): Promise<void> {
    for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
      const requests = await m.outgoingRequests();
      if (requests.length === 0) return;
      for (const request of requests) {
        const r = plain(request as unknown as CryptoRequest);
        const answer = await sendRequest(deviceId, r);
        await m.markRequestAsSent(r.id, r.type, answer);
      }
    }
    throw new CryptoError(
      `the speaker's crypto outbox did not settle in ${MAX_FLUSH_PASSES} passes`,
    );
  }

  /** Users not tried too recently in this room; marks those it answers. */
  function worthRetrying(roomId: string, users: string[]): string[] {
    const at = now();
    return users.filter((user) => {
      const key = `${roomId}\u0000${user}`;
      const previous = staleTried.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return false;
      staleTried.set(key, at);
      return true;
    });
  }

  async function shareKey(
    b: Binding,
    m: OlmMachine,
    deviceId: string,
    roomId: string,
    recipients: InstanceType<Binding["UserId"]>[],
  ) {
    const missing = await m.getMissingSessions(recipients);
    if (missing) {
      const r = plain(missing as unknown as CryptoRequest);
      const answer = await sendRequest(deviceId, {
        ...r,
        type: REQUEST_TYPE.KeysClaim,
      });
      await m.markRequestAsSent(r.id, REQUEST_TYPE.KeysClaim, answer);
    }
    return m.shareRoomKey(
      new b.RoomId(roomId),
      recipients,
      new b.EncryptionSettings(),
    );
  }

  return {
    async start() {
      await exclusive(() => machine());
    },

    receive(tx) {
      return exclusive(async () => {
        const b = await loaded();
        const { machine: m, deviceId } = await machine();
        const { otk, fallback } = speakerKeyCounts(tx, userId);
        await m.receiveSyncChanges(
          JSON.stringify(tx.toDevice),
          new b.DeviceLists(
            tx.deviceLists.changed.map((u) => new b.UserId(u)),
            tx.deviceLists.left.map((u) => new b.UserId(u)),
          ),
          otk,
          fallback,
        );
        await flush(m, deviceId);
      });
    },

    encrypt(roomId, members, eventType, content) {
      return exclusive(async () => {
        const others = [...new Set(members)].filter((u) => u !== userId);
        if (others.length === 0) {
          // An event only the speaker can read is a message nobody reads, sent as a success.
          throw new CryptoError(
            "refusing to encrypt to nobody but the speaker",
          );
        }
        const b = await loaded();
        const { machine: m, deviceId } = await machine();
        const recipients = [userId, ...others].map((u) => new b.UserId(u));

        // 1. Know the recipients' devices, and go and ask: tracking only marks them; the query
        //    comes out of the outbox.
        await m.updateTrackedUsers(recipients);
        await flush(m, deviceId);
        // 1b. Ask again, every send, for everyone but the speaker: a device a person added while
        //     no change reached this machine would otherwise never be shared with (agentpod#604).
        const query = m.queryKeysForUsers(others.map((u) => new b.UserId(u)));
        const queried = await sendRequest(deviceId, {
          id: query.id,
          type: REQUEST_TYPE.KeysQuery,
          body: query.body,
        });
        await m.markRequestAsSent(query.id, REQUEST_TYPE.KeysQuery, queried);

        // 2 and 3. An olm session with each device, then the room key over it.
        let shares = await shareKey(b, m, deviceId, roomId, recipients);

        // A device that refused a session (`m.no_olm`) gets one more chance with our copy of its
        // identity thrown away first; one that refuses again is left alone for a while.
        const stale = noOlmRecipients(shares as unknown as CryptoRequest[]);
        const retry = worthRetrying(roomId, stale);
        if (retry.length > 0) {
          log(
            `appservice: ${retry.length} device owner(s) refused an olm session; their devices are queried again`,
          );
          await m.receiveSyncChanges(
            "[]",
            new b.DeviceLists(
              retry.map((u) => new b.UserId(u)),
              [],
            ),
            {},
            [],
          );
          await flush(m, deviceId);
          shares = await shareKey(b, m, deviceId, roomId, recipients);
          const still = new Set(
            noOlmRecipients(shares as unknown as CryptoRequest[]),
          );
          for (const user of retry)
            if (!still.has(user)) staleTried.delete(`${roomId}\u0000${user}`);
        }

        for (const share of shares) {
          const r = share as unknown as CryptoRequest;
          const answer = await sendRequest(deviceId, {
            id: r.id,
            // A ToDeviceRequest carries no type of its own: it is implied by the class.
            type: REQUEST_TYPE.ToDevice,
            body: r.body,
            ...(r.eventType ? { eventType: r.eventType } : {}),
            ...(r.txnId ? { txnId: r.txnId } : {}),
          });
          await m.markRequestAsSent(r.id, REQUEST_TYPE.ToDevice, answer);
        }

        const encrypted = await m.encryptRoomEvent(
          new b.RoomId(roomId),
          eventType,
          JSON.stringify(content),
        );
        await flush(m, deviceId);
        return JSON.parse(encrypted) as Record<string, unknown>;
      });
    },

    decrypt(event) {
      return exclusive(async () => {
        const roomId = event.room_id;
        if (event.type !== ENCRYPTED_EVENT_TYPE || typeof roomId !== "string")
          return null;
        const b = await loaded();
        const { machine: m } = await machine();
        let decrypted: DecryptedRoomEvent;
        try {
          decrypted = await m.decryptRoomEvent(
            JSON.stringify(event),
            new b.RoomId(roomId),
          );
        } catch {
          // A missing key is expected, not exceptional: it is late, or was never sent here.
          return null;
        }
        return ownParts(decrypted.event, roomId);
      });
    },

    async close() {
      await lock.catch(() => undefined);
      const pending = built;
      built = null;
      if (pending === null) return;
      try {
        closeTrackedMachine((await pending).machine);
      } catch {
        // A machine that never built is not open.
      }
    },
  };

  async function loaded(): Promise<Binding> {
    binding ??= await import("@matrix-org/matrix-sdk-crypto-nodejs");
    return binding;
  }
}

/**
 * The speaker's own key counts in a whole-namespace transaction, its devices merged. Only its
 * own: another user's would make it believe its key pool is full when it is empty, and it would
 * stop replenishing and become unreachable without a fault.
 */
export function speakerKeyCounts(
  tx: CryptoTransaction,
  userId: string,
): { otk: Record<string, number>; fallback: string[] } {
  const otk: Record<string, number> = {};
  for (const perDevice of Object.values(tx.otkCounts[userId] ?? {})) {
    if (!isRecord(perDevice)) continue;
    for (const [algorithm, count] of Object.entries(perDevice))
      if (typeof count === "number") otk[algorithm] = count;
  }
  const fallback = new Set<string>();
  for (const list of Object.values(tx.unusedFallbackKeys[userId] ?? {})) {
    for (const algorithm of Array.isArray(list) ? list : [])
      if (typeof algorithm === "string") fallback.add(algorithm);
  }
  return { otk, fallback: [...fallback] };
}

/**
 * A decrypted event's type and content, or null. The plaintext is the sender's to write, so
 * nothing in it may say who sent it or where: those stay the envelope's. A plaintext naming
 * another room is not this room's event.
 */
export function ownParts(json: string, roomId: string): DecryptedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { type, content, room_id: inner } = parsed;
  if (typeof type !== "string" || !isRecord(content)) return null;
  if (inner !== undefined && inner !== roomId) return null;
  return { type, content };
}

/**
 * The users whose devices refused an olm session on a share: `shareRoomKey` reports them as an
 * `m.room_key.withheld` to-device message with `code: "m.no_olm"`, beside the real keys, and
 * nothing throws (agentpod#604). Parsed defensively.
 */
export function noOlmRecipients(
  requests: Array<{ eventType?: string; body?: string }>,
): string[] {
  const users = new Set<string>();
  for (const request of requests) {
    if (!(request.eventType ?? "").includes("withheld")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body ?? "{}");
    } catch {
      continue;
    }
    const messages = isRecord(parsed) ? parsed.messages : undefined;
    if (!isRecord(messages)) continue;
    for (const [user, devices] of Object.entries(messages)) {
      if (!isRecord(devices)) continue;
      for (const content of Object.values(devices)) {
        if (isRecord(content) && content.code === "m.no_olm") users.add(user);
      }
    }
  }
  return [...users];
}

/** A binding request as plain fields; the binding's getters are not own properties. */
function plain(request: CryptoRequest): CryptoRequest {
  return {
    id: request.id,
    type: request.type,
    body: request.body,
    ...(request.eventType ? { eventType: request.eventType } : {}),
    ...(request.txnId ? { txnId: request.txnId } : {}),
    ...(request.roomId ? { roomId: request.roomId } : {}),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === "MatrixClientError")
    return error.message;
  return error instanceof Error ? error.name : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
