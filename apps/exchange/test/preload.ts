/**
 * Loaded before every `bun test` run (bunfig.toml). Closes any encryption machine a test left
 * open, after the last test file: one still open when bun test exits aborts the run from inside
 * napi-rs after every test has passed, and bun test does not run `process.on("exit")` listeners.
 * `open-machines.ts` has no imports, so this loads no native binding.
 */
import { afterAll } from "bun:test";
import { closeOpenMachines } from "../src/appservice/open-machines.ts";

afterAll(() => {
  closeOpenMachines();
});
