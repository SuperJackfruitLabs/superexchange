/**
 * Every encryption machine this process has opened and not yet closed.
 *
 * Ported from the AgentPod hub's `services/matrix-as/open-machines.ts`. An `OlmMachine` still
 * open when the process exits aborts it: Bun runs napi's cleanup hooks as it exits, napi-rs drops
 * its Tokio runtime in one of them, and a machine torn down after that panics reaching for it
 * (SIGABRT, exit 134), whatever the process was doing. A machine closed first is safe.
 *
 * So every machine is recorded here and closed on the way out, by whichever exit is happening:
 *
 * - the service's SIGTERM and SIGINT handler, through `SpeakerCrypto.close()`;
 * - any other exit of a plain `bun` process, through the `exit` listener below, which runs before
 *   the cleanup hooks (including after `process.exit()`);
 * - `bun test`, through the `afterAll` in `test/preload.ts`: bun test does not run `exit`
 *   listeners.
 *
 * No imports, so the test preload loads this without loading the native binding.
 */

/** The one method this needs; `OlmMachine.close()` is synchronous. */
interface Closeable {
  close(): void;
}

const open = new Set<Closeable>();
let listening = false;

/** Record a machine the moment it exists. */
export function trackOpenMachine(machine: Closeable): void {
  open.add(machine);
  if (listening) return;
  listening = true;
  process.on("exit", closeOpenMachines);
}

/** Close one machine, forgetting it first so a throwing close is never retried. */
export function closeTrackedMachine(machine: Closeable): void {
  open.delete(machine);
  machine.close();
}

/** Close everything still open. Synchronous, so it is safe in an `exit` listener. */
export function closeOpenMachines(): void {
  // Deleting the entry being visited is safe in a Set's iteration.
  for (const machine of open) {
    try {
      closeTrackedMachine(machine);
    } catch {
      // Nothing to report to on the way out, and one bad machine must not keep the rest open.
    }
  }
}

/** How many machines are open now. For tests. */
export function openMachineCount(): number {
  return open.size;
}
