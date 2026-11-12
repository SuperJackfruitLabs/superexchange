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
] as const;

/** Where the store keeps its database when `SUPEREXCHANGE_DATA_DIR` is unset. */
export const DEFAULT_DATA_DIR = "/data";

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
   * Whether board rooms may be made and posted into without end-to-end encryption
   * (`SUPEREXCHANGE_PLAINTEXT_ROOMS`). Staging only, and only until SuperExchange encrypts: off,
   * nothing is posted at all.
   */
  plaintextRooms: boolean;
}

/**
 * The prefix a homeserver's server name must have for `SUPEREXCHANGE_PLAINTEXT_ROOMS` to be on.
 * Board rooms are encrypted (charter); plaintext is a staging allowance and never a production
 * one.
 */
export const PLAINTEXT_SERVER_PREFIX = "staging-";

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

  if (homeserverUrl !== "" && !isHttpUrl(homeserverUrl)) {
    problems.push("MATRIX_HOMESERVER_URL is not an http(s) URL");
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

  let port = DEFAULT_PORT;
  const rawPort = env.PORT?.trim();
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push("PORT is not a port number");
    }
  }

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
