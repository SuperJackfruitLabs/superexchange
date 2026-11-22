/**
 * Loaded before every `bun test` run (bunfig.toml).
 *
 * Closes any encryption machine a test left open, after the last test file: one still open when
 * bun test exits aborts the run from inside napi-rs after every test has passed, and bun test does
 * not run `process.on("exit")` listeners. `open-machines.ts` has no imports, so this loads no
 * native binding.
 *
 * Fails the test that sent a request treaty's contract refuses (`contracts.ts`'s `checkedFetch`).
 * `contract-violations.ts` has no imports either.
 */
import { afterAll, afterEach } from "bun:test";
import { closeOpenMachines } from "../src/appservice/open-machines.ts";
import { contractViolations } from "./contract-violations.ts";

afterEach(() => {
  if (contractViolations.length === 0) return;
  const found = contractViolations.splice(0);
  throw new Error(`requests outside treaty's contract:\n${found.join("\n")}`);
});

afterAll(() => {
  closeOpenMachines();
});
