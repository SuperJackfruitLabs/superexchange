import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  REQUIRED,
  loadConfig,
  secretMatches,
  tokenMatchesSha256,
} from "../src/config.ts";

const FULL = {
  MATRIX_HOMESERVER_URL: "https://matrix.example",
  MATRIX_SERVER_NAME: "example",
  MATRIX_AS_TOKEN: "as-token-for-tests",
  MATRIX_HS_TOKEN: "hs-token-for-tests",
  TREATY_RELAY_DELIVERY_SECRET: "relay-secret-for-tests",
  SUPEREXCHANGE_OPERATOR_TOKEN_SHA256: "ab".repeat(32),
  ORG_PLANE_URL: "https://accounts.example",
  ORG_PLANE_SERVICE_CREDENTIAL: `svc_${"0a".repeat(10)}:plane-secret-for-tests`,
  SUPERPIPELINE_URL: "https://pipeline.example",
  SUPEREXCHANGE_CRYPTO_PASSPHRASE: "crypto-passphrase-for-tests-0123456789",
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  test("reads a complete set, with the default port", () => {
    expect(loadConfig(FULL)).toEqual({
      port: 8080,
      homeserverUrl: "https://matrix.example",
      serverName: "example",
      asToken: "as-token-for-tests",
      hsToken: "hs-token-for-tests",
      relayDeliverySecret: "relay-secret-for-tests",
      dataDir: "/data",
      operatorTokenSha256: "ab".repeat(32),
      plaintextRooms: false,
      cryptoPassphrase: "crypto-passphrase-for-tests-0123456789",
      orgPlaneUrl: "https://accounts.example",
      orgPlaneCredential: {
        id: `svc_${"0a".repeat(10)}`,
        secret: "plane-secret-for-tests",
      },
      superpipelineUrl: "https://pipeline.example",
      sweepSeconds: 60,
    });
  });

  test("the sweep interval is whole seconds from 15 to a day, 60 when unset", () => {
    expect(
      loadConfig({ ...FULL, SUPEREXCHANGE_SWEEP_SECONDS: "15" }).sweepSeconds,
    ).toBe(15);
    expect(
      loadConfig({ ...FULL, SUPEREXCHANGE_SWEEP_SECONDS: " 300 " })
        .sweepSeconds,
    ).toBe(300);
    expect(
      loadConfig({ ...FULL, SUPEREXCHANGE_SWEEP_SECONDS: "" }).sweepSeconds,
    ).toBe(60);
    for (const bad of ["14", "0", "-60", "1.5", "60s", "86401", "1e3"]) {
      expect(problems({ ...FULL, SUPEREXCHANGE_SWEEP_SECONDS: bad })).toEqual([
        "SUPEREXCHANGE_SWEEP_SECONDS is not a whole number of seconds from 15 to 86400",
      ]);
    }
  });

  test("the organization plane and SuperPipeline are http(s) URLs", () => {
    expect(
      loadConfig({ ...FULL, SUPERPIPELINE_URL: "http://superpipeline:8787" })
        .superpipelineUrl,
    ).toBe("http://superpipeline:8787");
    expect(
      problems({
        ...FULL,
        ORG_PLANE_URL: "accounts.example",
        SUPERPIPELINE_URL: "ftp://pipeline.example",
      }),
    ).toEqual([
      "ORG_PLANE_URL is not an http(s) URL",
      "SUPERPIPELINE_URL is not an http(s) URL",
    ]);
  });

  test("the service credential is svc_<20 hex>:<secret>, and nothing else", () => {
    for (const bad of [
      "plane-secret-for-tests",
      `svc_${"0a".repeat(10)}`,
      `svc_${"0a".repeat(10)}:`,
      `svc_${"0a".repeat(9)}:plane-secret-for-tests`,
      `svc_${"0A".repeat(10)}:plane-secret-for-tests`,
      `svc_${"0a".repeat(10)}:plane secret`,
    ]) {
      expect(problems({ ...FULL, ORG_PLANE_SERVICE_CREDENTIAL: bad })).toEqual([
        "ORG_PLANE_SERVICE_CREDENTIAL is not svc_<20 hex digits>:<secret>",
      ]);
    }
  });

  test("takes a data directory, and refuses one that is not absolute", () => {
    expect(
      loadConfig({ ...FULL, SUPEREXCHANGE_DATA_DIR: "/var/lib/exchange" })
        .dataDir,
    ).toBe("/var/lib/exchange");
    expect(loadConfig({ ...FULL, SUPEREXCHANGE_DATA_DIR: " " }).dataDir).toBe(
      "/data",
    );
    expect(problems({ ...FULL, SUPEREXCHANGE_DATA_DIR: "data" })).toEqual([
      "SUPEREXCHANGE_DATA_DIR is not an absolute path",
    ]);
  });

  test("the operator token's hash is 64 hex digits, read in lowercase", () => {
    expect(
      loadConfig({
        ...FULL,
        SUPEREXCHANGE_OPERATOR_TOKEN_SHA256: "AB".repeat(32),
      }).operatorTokenSha256,
    ).toBe("ab".repeat(32));
    for (const bad of ["ab".repeat(31), "ab".repeat(33), "zz".repeat(32)]) {
      expect(
        problems({ ...FULL, SUPEREXCHANGE_OPERATOR_TOKEN_SHA256: bad }),
      ).toEqual([
        "SUPEREXCHANGE_OPERATOR_TOKEN_SHA256 is not 64 hex digits (a SHA-256)",
      ]);
    }
  });

  test("names every missing setting at once", () => {
    expect(problems({})).toEqual([
      ...REQUIRED.map((name) => `${name} is not set`),
      "SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set, and board rooms are encrypted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
    ]);
  });

  test("a blank setting is a missing one", () => {
    expect(problems({ ...FULL, MATRIX_AS_TOKEN: "  " })).toEqual([
      "MATRIX_AS_TOKEN is not set",
    ]);
  });

  test("refuses a homeserver that is not an http(s) URL", () => {
    expect(
      problems({ ...FULL, MATRIX_HOMESERVER_URL: "matrix.example" }),
    ).toEqual(["MATRIX_HOMESERVER_URL is not an http(s) URL"]);
  });

  test("refuses one token used both ways", () => {
    expect(
      problems({ ...FULL, MATRIX_HS_TOKEN: FULL.MATRIX_AS_TOKEN }),
    ).toEqual(["MATRIX_AS_TOKEN and MATRIX_HS_TOKEN are the same"]);
  });

  test("takes a port, and refuses one that is not a port", () => {
    expect(loadConfig({ ...FULL, PORT: "9123" }).port).toBe(9123);
    expect(problems({ ...FULL, PORT: "70000" })).toEqual([
      "PORT is not a port number",
    ]);
    expect(problems({ ...FULL, PORT: "80a" })).toEqual([
      "PORT is not a port number",
    ]);
  });

  test("plaintext rooms are off unless set on, and anything else is refused", () => {
    expect(loadConfig(FULL).plaintextRooms).toBe(false);
    const staging = { ...FULL, MATRIX_SERVER_NAME: "staging-matrix.example" };
    expect(
      loadConfig({ ...staging, SUPEREXCHANGE_PLAINTEXT_ROOMS: "off" })
        .plaintextRooms,
    ).toBe(false);
    expect(
      loadConfig({ ...staging, SUPEREXCHANGE_PLAINTEXT_ROOMS: " " })
        .plaintextRooms,
    ).toBe(false);
    expect(
      loadConfig({ ...staging, SUPEREXCHANGE_PLAINTEXT_ROOMS: "on" })
        .plaintextRooms,
    ).toBe(true);
    for (const bad of ["true", "1", "yes"]) {
      expect(
        problems({ ...staging, SUPEREXCHANGE_PLAINTEXT_ROOMS: bad }),
      ).toEqual(["SUPEREXCHANGE_PLAINTEXT_ROOMS is not on or off"]);
    }
  });

  test("plaintext rooms on a server that is not staging stop the service", () => {
    for (const serverName of [
      "example",
      "matrix.example",
      "matrix-staging-.example",
      "Staging-matrix.example",
    ]) {
      expect(
        problems({
          ...FULL,
          MATRIX_SERVER_NAME: serverName,
          SUPEREXCHANGE_PLAINTEXT_ROOMS: "on",
        }),
      ).toEqual([
        "SUPEREXCHANGE_PLAINTEXT_ROOMS is on, and is allowed only when MATRIX_SERVER_NAME starts with staging-",
      ]);
    }
    // Off, any server name is fine.
    expect(
      loadConfig({ ...FULL, SUPEREXCHANGE_PLAINTEXT_ROOMS: "off" })
        .plaintextRooms,
    ).toBe(false);
  });

  test("the crypto passphrase is required while plaintext rooms are off, and is at least 32 characters", () => {
    const { SUPEREXCHANGE_CRYPTO_PASSPHRASE: _, ...none } = FULL;
    expect(problems(none)).toEqual([
      "SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set, and board rooms are encrypted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
    ]);
    expect(
      problems({ ...FULL, SUPEREXCHANGE_CRYPTO_PASSPHRASE: "   " }),
    ).toEqual([
      "SUPEREXCHANGE_CRYPTO_PASSPHRASE is not set, and board rooms are encrypted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off",
    ]);
    expect(
      problems({ ...FULL, SUPEREXCHANGE_CRYPTO_PASSPHRASE: "x".repeat(31) }),
    ).toEqual([
      "SUPEREXCHANGE_CRYPTO_PASSPHRASE is shorter than 32 characters",
    ]);
    // Used exactly as given: not trimmed.
    expect(
      loadConfig({
        ...FULL,
        SUPEREXCHANGE_CRYPTO_PASSPHRASE: ` ${"y".repeat(32)} `,
      }).cryptoPassphrase,
    ).toBe(` ${"y".repeat(32)} `);
    // Plaintext rooms on (staging), it may be left unset: nothing is encrypted then.
    const staging = {
      ...none,
      MATRIX_SERVER_NAME: "staging-matrix.example",
      SUPEREXCHANGE_PLAINTEXT_ROOMS: "on",
    };
    expect(loadConfig(staging).cryptoPassphrase).toBeNull();
    // ... and when set, it is still checked, and used.
    expect(
      problems({ ...staging, SUPEREXCHANGE_CRYPTO_PASSPHRASE: "short" }),
    ).toEqual([
      "SUPEREXCHANGE_CRYPTO_PASSPHRASE is shorter than 32 characters",
    ]);
    expect(
      loadConfig({
        ...staging,
        SUPEREXCHANGE_CRYPTO_PASSPHRASE: FULL.SUPEREXCHANGE_CRYPTO_PASSPHRASE,
      }).cryptoPassphrase,
    ).toBe(FULL.SUPEREXCHANGE_CRYPTO_PASSPHRASE);
  });

  test("an error never carries a setting's value", () => {
    const env = {
      ...FULL,
      MATRIX_HOMESERVER_URL: "not a url",
      MATRIX_HS_TOKEN: FULL.MATRIX_AS_TOKEN,
      SUPEREXCHANGE_OPERATOR_TOKEN_SHA256: "not-a-hash-value",
      SUPEREXCHANGE_DATA_DIR: "relative/data-dir",
      MATRIX_SERVER_NAME: "prod-homeserver.example",
      SUPEREXCHANGE_PLAINTEXT_ROOMS: "on",
      ORG_PLANE_URL: "not-a-plane-url",
      ORG_PLANE_SERVICE_CREDENTIAL: "svc_short:plane-secret-for-tests",
      SUPERPIPELINE_URL: "not-a-pipeline-url",
      SUPEREXCHANGE_CRYPTO_PASSPHRASE: "short-passphrase",
    };
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    // The plaintext switch's "on" is a word of every sentence; every other value is checked.
    for (const [name, value] of Object.entries(env))
      if (name !== "SUPEREXCHANGE_PLAINTEXT_ROOMS")
        expect(message).not.toContain(value);
  });
});

describe("secret comparison", () => {
  test("a secret matches only itself, and an empty one matches nothing", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3cret", "s3creT")).toBe(false);
    expect(secretMatches("s3cret", "s3cret-longer")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  test("a token matches the SHA-256 it hashes to, and nothing else", () => {
    const hash = new Bun.CryptoHasher("sha256").update("tok").digest("hex");
    expect(tokenMatchesSha256(hash, "tok")).toBe(true);
    expect(tokenMatchesSha256(hash.toUpperCase(), "tok")).toBe(true);
    expect(tokenMatchesSha256(hash, "tok2")).toBe(false);
    expect(tokenMatchesSha256(hash, hash)).toBe(false);
    expect(tokenMatchesSha256("", "")).toBe(false);
    expect(tokenMatchesSha256("ab", "tok")).toBe(false);
  });
});
