/**
 * Opens an encryption machine, records it as this service does, and exits without closing it.
 * Run by `crypto-exit.test.ts` in a process of its own: the `exit` listener that recording
 * installs must close the machine before napi tears its runtime down.
 */
import {
  DeviceId,
  OlmMachine,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { trackOpenMachine } from "../../src/appservice/open-machines.ts";

const machine = await OlmMachine.initialize(
  new UserId("@superexchange_board:example.test"),
  new DeviceId("EXITTEST"),
);
trackOpenMachine(machine);
process.exit(0);
