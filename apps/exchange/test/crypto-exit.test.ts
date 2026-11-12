import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * An encryption machine still open at exit aborts the process (napi-rs reaches for a Tokio
 * runtime it already dropped: SIGABRT, exit 134). Measured on Bun 1.2.8: every run without the
 * `exit` listener in `open-machines.ts` aborted. Run in a process of its own, because the abort
 * is the process's.
 */
describe("an open machine at exit", () => {
  test("is closed by the exit listener, and the process exits cleanly", () => {
    const run = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "fixtures", "exit-with-open-machine.ts"),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).not.toContain("panicked");
    expect(run.exitCode).toBe(0);
  });
});
