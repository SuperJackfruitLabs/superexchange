import { afterEach, describe, expect, test } from "bun:test";
import { createHandler } from "../src/routes/index.ts";
import {
  HS_TOKEN,
  OPERATOR_TOKEN,
  OPERATOR_TOKEN_SHA256,
  RELAY_SECRET,
  captureLog,
  tempStore,
} from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  return createHandler({
    config: {
      hsToken: HS_TOKEN,
      relayDeliverySecret: RELAY_SECRET,
      operatorTokenSha256: OPERATOR_TOKEN_SHA256,
    },
    store: t.store,
    onEvents: () => {},
    log: captureLog().log,
  });
}

describe("the HTTP surface", () => {
  test("the health check answers", async () => {
    const response = await setup()(new Request("http://exchange/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "superexchange",
    });
  });

  test("each surface is reached through the dispatcher", async () => {
    const handle = setup();
    const ping = await handle(
      new Request("http://exchange/_matrix/app/v1/ping", {
        method: "POST",
        headers: { authorization: `Bearer ${HS_TOKEN}` },
      }),
    );
    expect(ping.status).toBe(200);
    const boards = await handle(
      new Request("http://exchange/v1/boards", {
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
    );
    expect(await boards.json()).toEqual({ boards: [] });
    const relay = await handle(
      new Request("http://exchange/v1/relay/events", { method: "POST" }),
    );
    expect(relay.status).toBe(400);
  });

  test("anything else is not found", async () => {
    const handle = setup();
    expect((await handle(new Request("http://exchange/"))).status).toBe(404);
    expect(
      (await handle(new Request("http://exchange/healthz", { method: "POST" })))
        .status,
    ).toBe(404);
    expect(
      (await handle(new Request("http://exchange/v1/relay/events"))).status,
    ).toBe(404);
    expect(
      (await handle(new Request("http://exchange/v1/boardsX"))).status,
    ).toBe(404);
  });
});
