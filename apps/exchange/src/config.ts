/**
 * The service's settings, read once at boot. A missing or malformed setting stops the service
 * before it listens, and the error names the setting, never its value.
 */

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
] as const;

export interface Config {
  port: number;
  homeserverUrl: string;
  serverName: string;
  asToken: string;
  hsToken: string;
  relayDeliverySecret: string;
}

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

  if (homeserverUrl !== "" && !isHttpUrl(homeserverUrl)) {
    problems.push("MATRIX_HOMESERVER_URL is not an http(s) URL");
  }
  if (asToken !== "" && asToken === hsToken) {
    problems.push("MATRIX_AS_TOKEN and MATRIX_HS_TOKEN are the same");
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
