import { describe, expect, test } from "bun:test";
import { ConfigError, REQUIRED, loadConfig } from "../src/config.ts";

const FULL = {
  MATRIX_HOMESERVER_URL: "https://matrix.example",
  MATRIX_SERVER_NAME: "example",
  MATRIX_AS_TOKEN: "as-token-for-tests",
  MATRIX_HS_TOKEN: "hs-token-for-tests",
  TREATY_RELAY_DELIVERY_SECRET: "relay-secret-for-tests",
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
    });
  });

  test("names every missing setting at once", () => {
    expect(problems({})).toEqual(REQUIRED.map((name) => `${name} is not set`));
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

  test("an error never carries a setting's value", () => {
    const env = {
      ...FULL,
      MATRIX_HOMESERVER_URL: "not a url",
      MATRIX_HS_TOKEN: FULL.MATRIX_AS_TOKEN,
    };
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    for (const value of Object.values(env))
      expect(message).not.toContain(value);
  });
});
