import { afterEach, describe, expect, test } from "bun:test";
import {
  SIGNATURE_HEADER,
  signDelivery,
  toBinary,
} from "@superjackfruitlabs/treaty-cloudevents";
import { GATE_PENDING_V1 } from "../src/board-chat/index.ts";
import { MAX_RELAY_BODY, createRelayHandler } from "../src/routes/relay.ts";
import { RELAY_SECRET, captureLog, gateBody, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const { log, lines } = captureLog();
  const accepted: string[] = [];
  const handle = createRelayHandler({
    secret: RELAY_SECRET,
    store: t.store,
    log,
    onGateAccepted: (gateId) => accepted.push(gateId),
  });
  return { handle, store: t.store, lines, accepted };
}

const UTF8 = new TextEncoder();

async function delivery(
  data: unknown,
  {
    type = GATE_PENDING_V1,
    id = "evt-1",
    secret = RELAY_SECRET,
    nowMs = Date.now(),
    raw,
  }: {
    type?: string;
    id?: string;
    secret?: string;
    nowMs?: number;
    raw?: Uint8Array;
  } = {},
) {
  const body = raw ?? UTF8.encode(JSON.stringify(data));
  const message = toBinary(
    {
      attributes: {
        id,
        source: "superpipeline",
        specversion: "1.0",
        type,
        datacontenttype: "application/json",
      },
      data: body,
    },
    "http",
  );
  return new Request("http://exchange/v1/relay/events", {
    method: "POST",
    headers: {
      ...message.headers,
      [SIGNATURE_HEADER]: await signDelivery(secret, id, body, nowMs),
    },
    body: body as BodyInit,
  });
}

function optIn(store: ReturnType<typeof setup>["store"], boardId = "brd_7c1f") {
  store.upsertBoard({
    boardId,
    spTenantId: "tnt_1",
    orgId: "org_1",
    invitees: ["@ana:example.test"],
  });
}

describe("relay deliveries", () => {
  test("the type it accepts is SuperPipeline's gate.pending v1", () => {
    expect(GATE_PENDING_V1).toBe(
      "com.superjackfruit.superpipeline.gate.pending.v1",
    );
  });

  test("a gate for an opted-in board is recorded, once", async () => {
    const { handle, store } = setup();
    optIn(store);
    const first = await handle(await delivery(gateBody()));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(store.gateDelivery("gte_1")).toEqual({
      boardId: "brd_7c1f",
      body: gateBody(),
      settledAt: null,
    });

    const again = await handle(
      await delivery(gateBody({ cardTitle: "changed" }), { id: "evt-2" }),
    );
    expect(await again.json()).toEqual({ status: "accepted" });
    expect(store.gateDelivery("gte_1")?.body).toEqual(gateBody());
  });

  test("an accepted gate, and its redelivery, are handed on to be posted", async () => {
    const { handle, store, accepted } = setup();
    optIn(store);
    await handle(await delivery(gateBody()));
    await handle(await delivery(gateBody(), { id: "evt-2" }));
    expect(accepted).toEqual(["gte_1", "gte_1"]);
  });

  test("a gate for a board not opted in, or disabled, is ignored and not recorded", async () => {
    const { handle, store, accepted } = setup();
    const unknown = await handle(await delivery(gateBody()));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ status: "ignored" });

    optIn(store);
    store.disableBoard("brd_7c1f");
    const disabled = await handle(await delivery(gateBody()));
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ status: "ignored" });
    expect(store.gateDelivery("gte_1")).toBeNull();
    expect(accepted).toEqual([]);
  });

  test("another event type is ignored, even for an opted-in board", async () => {
    const { handle, store } = setup();
    optIn(store);
    const response = await handle(
      await delivery(gateBody(), {
        type: "com.superjackfruit.superpipeline.gate.resolved.v1",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored" });
    expect(store.gateDelivery("gte_1")).toBeNull();
  });

  test("a bad, stale or missing signature is 401 and nothing is recorded", async () => {
    const { handle, store, lines } = setup();
    optIn(store);
    const wrongSecret = await handle(
      await delivery(gateBody(), { secret: "another-secret" }),
    );
    expect(wrongSecret.status).toBe(401);

    const stale = await handle(
      await delivery(gateBody(), { nowMs: Date.now() - 3_600_000 }),
    );
    expect(stale.status).toBe(401);

    const unsigned = await delivery(gateBody());
    unsigned.headers.delete(SIGNATURE_HEADER);
    expect((await handle(unsigned)).status).toBe(401);

    // Signed over one body, carrying another.
    const signed = await delivery(gateBody());
    const swapped = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(gateBody({ gateId: "gte_forged" })),
    });
    expect((await handle(swapped)).status).toBe(401);

    expect(store.gateDelivery("gte_1")).toBeNull();
    expect(store.gateDelivery("gte_forged")).toBeNull();
    expect(lines.join("\n")).not.toContain(RELAY_SECRET);
  });

  test("not a CloudEvent is 400", async () => {
    const { handle } = setup();
    const response = await handle(
      new Request("http://exchange/v1/relay/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gateBody()),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a signed gate.pending that is not JSON, or not a gate, is 400", async () => {
    const { handle, store } = setup();
    optIn(store);
    const notJson = await handle(
      await delivery(null, { raw: UTF8.encode("{nope") }),
    );
    expect(notJson.status).toBe(400);
    const notGate = await handle(
      await delivery(gateBody({ options: "none", gateId: "gte_bad" })),
    );
    expect(notGate.status).toBe(400);
    expect(store.gateDelivery("gte_bad")).toBeNull();
  });

  test("a body over the ceiling is 413", async () => {
    const { handle } = setup();
    const raw = UTF8.encode("x".repeat(MAX_RELAY_BODY + 1));
    expect((await handle(await delivery(null, { raw }))).status).toBe(413);
  });
});
