import { expect, test } from "bun:test";
import { verifyDelivery } from "@superjackfruitlabs/treaty-cloudevents";
import {
  GATE_V2_SUITE_TYPE,
  parseGateDecision,
} from "@superjackfruitlabs/treaty-matrix-events";

// The two treaty packages this service is built on, at the versions package.json pins: the
// relay's delivery signature, and the board-room event contract.
test("the treaty contracts resolve", () => {
  expect(typeof verifyDelivery).toBe("function");
  expect(typeof parseGateDecision).toBe("function");
  expect(GATE_V2_SUITE_TYPE).toBe("dev.superpipeline.gate.v2");
});
