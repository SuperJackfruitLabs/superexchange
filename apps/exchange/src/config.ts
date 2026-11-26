/**
 * The service's settings, read once at boot, and how a presented secret is checked against one.
 * A missing or malformed setting stops the service before it listens, and the error names the
 * setting, never its value.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Settings that have no default. */
export const REQUIRED = [
  /** Where the homeserver's client-server API answers. */
  "MATRIX_HOMESERVER_URL",
  /** The homeserver's server name: the part of a Matrix ID after the colon. */
  "MATRIX_SERVER_NAME",
  /** The token this appservice sends to the homeserver (its registration's `as_token`). */
  "MATRIX_AS_TOKEN",
  /** The token the homeserver sends to this appservice (its registration's `hs_token`). */
  "MATRIX_HS_TOKEN",
  /** The secret the event relay signs its deliveries with (treaty's `verifyDelivery`). */
  "TREATY_RELAY_DELIVERY_SECRET",
  /**
   * The SHA-256 of the operator's bearer token for the board opt-in API, as 64 hex digits. The
   * token itself is never given to the service, so a leaked environment does not leak it.
   */
  "SUPEREXCHANGE_OPERATOR_TOKEN_SHA256",
  /** Where the organization plane (Accounts) answers: who a Matrix sender is, and assertions. */
  "ORG_PLANE_URL",
  /**
   * This service's own credential at the organization plane, `svc_<20 hex>:<secret>`. Sent only
   * to the plane, as a bearer; never logged.
   */
  "ORG_PLANE_SERVICE_CREDENTIAL",
  /**
   * Where SuperPipeline's API answers. A person's answer to a gate is resolved there, with an
   * assertion whose audience is this same URL.
   */
  "SUPERPIPELINE_URL",
] as const;

/**
 * The superdial token service's settings (`calls/`, the C5 routes). All unset, the service is off
 * and its routes are 404; some set, the service stops, naming the missing ones. `LIVEKIT_API_URL`
 * is optional and turns nothing on by itself.
 */
export const SUPERDIAL_SETTINGS = [
  /** The public `wss://` URL callers connect to LiveKit at; answered as `url` by `/v1/token`. */
  "LIVEKIT_URL",
  /** The LiveKit API key tokens are signed under, and webhooks are checked against. */
  "LIVEKIT_API_KEY",
  /** That key's secret. */
  "LIVEKIT_API_SECRET",
  /** Where the AgentPod hub answers its membership check (C4). */
  "SUPERDIAL_HUB_URL",
  /** The bearer the hub's membership check takes (`SUPERDIAL_MEMBERSHIP_TOKEN`). */
  "SUPERDIAL_MEMBERSHIP_TOKEN",
] as const;

/** Where the store keeps its database when `SUPEREXCHANGE_DATA_DIR` is unset. */
export const DEFAULT_DATA_DIR = "/data";

/** How often the gate sweep asks each board, in seconds, when `SUPEREXCHANGE_SWEEP_SECONDS` is unset. */
export const DEFAULT_SWEEP_SECONDS = 60;
/** The shortest sweep interval accepted: every board is asked once per pass. */
export const MIN_SWEEP_SECONDS = 15;
/** The longest: a day. */
export const MAX_SWEEP_SECONDS = 86_400;

export interface Config {
  port: number;
  homeserverUrl: string;
  serverName: string;
  asToken: string;
  hsToken: string;
  relayDeliverySecret: string;
  /** The directory the store keeps its database in; absolute. */
  dataDir: string;
  /** The SHA-256 of the operator's bearer token, 64 lowercase hex digits. */
  operatorTokenSha256: string;
  /**
   * Whether new board rooms are made without end-to-end encryption, and rooms made so may be
   * posted into (`SUPEREXCHANGE_PLAINTEXT_ROOMS`). Staging only. Off (the default), new rooms are
   * encrypted and a plaintext room made earlier is left as it is.
   */
  plaintextRooms: boolean;
  /**
   * The passphrase the speaker's crypto store is encrypted with
   * (`SUPEREXCHANGE_CRYPTO_PASSPHRASE`); null when unset, and then nothing is encrypted or
   * decrypted. Required while plaintext rooms are off.
   */
  cryptoPassphrase: string | null;
  /** The organization plane's URL. */
  orgPlaneUrl: string;
  /** This service's credential at the organization plane. */
  orgPlaneCredential: ServiceCredential;
  /** SuperPipeline's API URL, and the audience of every assertion asked for it. */
  superpipelineUrl: string;
  /** How often the gate sweep asks each enabled board, in seconds (`SUPEREXCHANGE_SWEEP_SECONDS`). */
  sweepSeconds: number;
  /** The superdial token service's settings; null when it is off. */
  superdial: SuperdialConfig | null;
}

/** The superdial token service: LiveKit, and the hub's membership check. */
export interface SuperdialConfig {
  /** The public `ws(s)://` URL of LiveKit, given to callers. */
  livekitUrl: string;
  /**
   * LiveKit's server API, http(s): `LIVEKIT_API_URL`, else `livekitUrl` with `wss` read as
   * `https` and `ws` as `http`.
   */
  livekitApiUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** The AgentPod hub's base URL, where `/internal/superdial/membership` answers. */
  hubUrl: string;
  /** The bearer for the hub's membership check. */
  membershipToken: string;
}

/** A service principal's credential: its id and its secret. */
export interface ServiceCredential {
  id: string;
  secret: string;
}

/** The shape of a service credential: `svc_` and 20 hex digits, a colon, then the secret. */
const SERVICE_CREDENTIAL = /^(svc_[0-9a-f]{20}):(\S+)$/;

/**
 * The prefix a homeserver's server name must have for `SUPEREXCHANGE_PLAINTEXT_ROOMS` to be on.
 * Board rooms are encrypted (charter); plaintext is a staging allowance and never a production
 * one.
 */
export const PLAINTEXT_SERVER_PREFIX = "staging-";

/** The shortest crypto store passphrase accepted, in characters. */
export const MIN_CRYPTO_PASSPHRASE = 32;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`superexchange cannot start: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const DEFAULT_PORT = 8080;

/** Read and check the settings; throws a ConfigError listing every problem at once. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const read = (name: (typeof REQUIRED)[number]): string => {
    const value = env[name]?.trim() ?? "";
    if (value === "") problems.push(`${name} is not set`);
    return value;
  };

  const homeserverUrl = read("MATRIX_HOMESERVER_URL");
  const serverName = read("MATRIX_SERVER_NAME");
  const asToken = read("MATRIX_AS_TOKEN");
  const hsToken = read("MATRIX_HS_TOKEN");
  const relayDeliverySecret = read("TREATY_RELAY_DELIVERY_SECRET");
  const operatorTokenSha256 = read(
    "SUPEREXCHANGE_OPERATOR_TOKEN_SHA256",
  ).toLowerCase();

  const orgPlaneUrl = read("ORG_PLANE_URL");
  const rawCredential = read("ORG_PLANE_SERVICE_CREDENTIAL");
  const superpipelineUrl = read("SUPERPIPELINE_URL");

  for (const [name, value] of [
    ["MATRIX_HOMESERVER_URL", homeserverUrl],
    ["ORG_PLANE_URL", orgPlaneUrl],
    ["SUPERPIPELINE_URL", superpipelineUrl],
  ] as const) {
    if (value !== "" && !isHttpUrl(value)) {
      problems.push(`${name} is not an http(s) URL`);
    }
  }
  const credential = SERVICE_CREDENTIAL.exec(rawCredential);
  if (rawCredential !== "" && credential === null) {
    problems.push(
      "ORG_PLANE_SERVICE_CREDENTIAL is not svc_<20 hex digits>:<secret>",
    );
  }
  if (asToken !== "" && asToken === hsToken) {
    problems.push("MATRIX_AS_TOKEN and MATRIX_HS_TOKEN are the same");
  }

  if (
    operatorTokenSha256 !== "" &&
    !/^[0-9a-f]{64}$/.test(operatorTokenSha256)
  ) {
    problems.push(
      "SUPEREXCHANGE_OPERATOR_TOKEN_SHA256 is not 64 hex digits (a SHA-256)",
    );
  }

  const dataDir = env.SUPEREXCHANGE_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  if (!dataDir.startsWith("/")) {
    problems.push("SUPEREXCHANGE_DATA_DIR is not an absolute path");
  }

  let plaintextRooms = false;
  const rawPlaintext = env.SUPEREXCHANGE_PLAINTEXT_ROOMS?.trim().toLowerCase();
  if (rawPlaintext === "on") plaintextRooms = true;
  else if (
    rawPlaintext !== undefined &&
    rawPlaintext !== "" &&
    rawPlaintext !== "off"
  ) {
    problems.push("SUPEREXCHANGE_PLAINTEXT_ROOMS is not on or off");
  }
  // Fail closed: plaintext rooms on anything but a staging homeserver stop the service.
  if (
    plaintextRooms &&
    serverName !== "" &&
    !serverName.startsWith(PLAINTEXT_SERVER_PREFIX)
  ) {
    problems.push(
      `SUPEREXCHANGE_PLAINTEXT_ROOMS is on, and is allowed only when MATRIX_SERVER_NAME starts with ${PLAINTEXT_SERVER_PREFIX}`,
    );
  }

  // Not trimmed: a passphrase is used exactly as given. Never quoted in a problem.
  const rawPassphrase = env.SUPEREXCHANGE_CRYPTO_PASSPHRASE ?? "";
  let cryptoPassphrase: string | null = null;
  if (rawPassphrase.trim() === "") {
    if (!plaintextRooms) {
      problems.push(
        "SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set, and board rooms are encrypted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
      );
    }
  } else if (rawPassphrase.length < MIN_CRYPTO_PASSPHRASE) {
    problems.push(
      `SUPEREXCHANGE_CRYPTO_PASSPHRASE is shorter than ${MIN_CRYPTO_PASSPHRASE} characters`,
    );
  } else {
    cryptoPassphrase = rawPassphrase;
  }

  let port = DEFAULT_PORT;
  const rawPort = env.PORT?.trim();
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push("PORT is not a port number");
    }
  }

  let sweepSeconds = DEFAULT_SWEEP_SECONDS;
  const rawSweep = env.SUPEREXCHANGE_SWEEP_SECONDS?.trim();
  if (rawSweep) {
    sweepSeconds = /^\d+$/.test(rawSweep) ? Number(rawSweep) : NaN;
    if (
      !Number.isInteger(sweepSeconds) ||
      sweepSeconds < MIN_SWEEP_SECONDS ||
      sweepSeconds > MAX_SWEEP_SECONDS
    ) {
      problems.push(
        `SUPEREXCHANGE_SWEEP_SECONDS is not a whole number of seconds from ${MIN_SWEEP_SECONDS} to ${MAX_SWEEP_SECONDS}`,
      );
    }
  }

  const superdial = readSuperdial(env, problems);

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    port,
    homeserverUrl,
    serverName,
    asToken,
    hsToken,
    relayDeliverySecret,
    dataDir,
    operatorTokenSha256,
    plaintextRooms,
    cryptoPassphrase,
    orgPlaneUrl,
    orgPlaneCredential: {
      id: credential?.[1] ?? "",
      secret: credential?.[2] ?? "",
    },
    superpipelineUrl,
    sweepSeconds,
    superdial,
  };
}

/** The superdial settings, null when none is set; problems are added to `problems`. */
function readSuperdial(
  env: Record<string, string | undefined>,
  problems: string[],
): SuperdialConfig | null {
  const value = (name: string) => env[name]?.trim() ?? "";
  const apiUrl = value("LIVEKIT_API_URL");
  if (SUPERDIAL_SETTINGS.every((name) => value(name) === "") && apiUrl === "") {
    return null;
  }
  for (const name of SUPERDIAL_SETTINGS) {
    if (value(name) === "") {
      problems.push(
        `${name} is not set, and the superdial token service needs it`,
      );
    }
  }
  const livekitUrl = value("LIVEKIT_URL");
  let derived = "";
  if (livekitUrl !== "") {
    try {
      const u = new URL(livekitUrl);
      if (
        (u.protocol === "wss:" || u.protocol === "ws:") &&
        u.hostname !== ""
      ) {
        u.protocol = u.protocol === "wss:" ? "https:" : "http:";
        derived = u.toString().replace(/\/+$/, "");
      }
    } catch {
      derived = "";
    }
    if (derived === "") problems.push("LIVEKIT_URL is not a ws(s) URL");
  }
  if (apiUrl !== "" && !isHttpUrl(apiUrl)) {
    problems.push("LIVEKIT_API_URL is not an http(s) URL");
  }
  const hubUrl = value("SUPERDIAL_HUB_URL");
  if (hubUrl !== "" && !isHttpUrl(hubUrl)) {
    problems.push("SUPERDIAL_HUB_URL is not an http(s) URL");
  }
  return {
    livekitUrl,
    livekitApiUrl: apiUrl || derived,
    livekitApiKey: value("LIVEKIT_API_KEY"),
    livekitApiSecret: value("LIVEKIT_API_SECRET"),
    hubUrl,
    membershipToken: value("SUPERDIAL_MEMBERSHIP_TOKEN"),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== ""
    );
  } catch {
    return false;
  }
}

/**
 * Does a presented secret equal the expected one? In constant time: both sides are hashed first,
 * so neither the content nor the length of a wrong guess changes how long the answer takes. An
 * empty expected secret matches nothing.
 */
export function secretMatches(expected: string, presented: string): boolean {
  if (expected === "") return false;
  return timingSafeEqual(sha256(expected), sha256(presented));
}

/**
 * Does a presented token hash to the expected SHA-256 (64 hex digits)? In constant time. A
 * malformed expected hash matches nothing.
 */
export function tokenMatchesSha256(
  expectedHex: string,
  presented: string,
): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), sha256(presented));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
