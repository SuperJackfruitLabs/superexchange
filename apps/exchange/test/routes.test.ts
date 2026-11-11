import { expect, test } from "bun:test";
import { handle } from "../src/routes/index.ts";

test("the health check answers", async () => {
  const response = handle(new Request("http://exchange/healthz"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "superexchange" });
});

test("anything else is not found", () => {
  expect(handle(new Request("http://exchange/")).status).toBe(404);
  expect(
    handle(new Request("http://exchange/healthz", { method: "POST" })).status,
  ).toBe(404);
});
