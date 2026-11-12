/**
 * Running a sweep: one pass now, then one every interval, never two at once. A pass in which every
 * board failed waits twice as long before the next, up to `SWEEP_MAX_BACKOFF` times the interval;
 * a pass that read any board goes back to the interval. Shared by the gate sweep and the question
 * sweep, each with its own backoff.
 */

/** The most the interval is multiplied by while every board keeps failing. */
export const SWEEP_MAX_BACKOFF = 8;

export interface Sweeper {
  stop(): void;
}

export interface SweeperOptions {
  intervalMs: number;
  /** Test seams: how the next pass is scheduled and cancelled. */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** What a pass says of itself: how many boards it asked, and how many could not be read. */
export interface PassResult {
  boards: number;
  failedBoards: number;
}

export function startSweeper(
  pass: () => Promise<PassResult>,
  onError: (error: unknown) => void,
  options: SweeperOptions,
): Sweeper {
  const schedule =
    options.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let failing = 0;
  let stopped = false;
  let handle: unknown = null;

  async function run(): Promise<void> {
    try {
      const r = await pass();
      failing = r.boards > 0 && r.failedBoards === r.boards ? failing + 1 : 0;
    } catch (error) {
      failing++;
      onError(error);
    }
    if (stopped) return;
    const factor = Math.min(2 ** failing, SWEEP_MAX_BACKOFF);
    handle = schedule(() => void run(), options.intervalMs * factor);
  }

  void run();
  return {
    stop() {
      stopped = true;
      if (handle !== null) cancel(handle);
    },
  };
}
