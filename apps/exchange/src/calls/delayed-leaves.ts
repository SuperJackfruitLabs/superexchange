/**
 * The cleanup after a dead call client (C5; protocol.md, "Ghost memberships").
 *
 * A caller arms an MSC4140 delayed leave (its empty call membership, sent by the homeserver after
 * 8 s unless restarted), then hands its `delay_id` here. While LiveKit has that identity in the
 * room, this restarts the delay every 3 s, so a client that dies without hanging up still leaves
 * the call once LiveKit notices it gone. The restarts keep that cadence whatever else is slow:
 * each pass starts on time, whether or not the last one finished; a leave's restart waits on
 * nothing (not its presence check, not another leave), and gives up before the next is due, so one
 * failed restart still leaves the next inside the 8 s. It sends the delay:
 *
 * - on `participant_left` or `participant_connection_aborted` for that identity's session, or
 *   `room_finished` for its room. The session is the one `participant_joined` last named: a
 *   rejoin under the same identity makes LiveKit remove the old session and say that one left,
 *   which is not the caller leaving. When no session is known (no joined webhook since this
 *   service started) or it is the known one, LiveKit is asked first, and an identity it still
 *   has is kept (a rejoin whose joined webhook is still to come); one LiveKit cannot say about
 *   is sent, since the webhook says it left;
 * - when the identity has not connected 30 s after it was registered;
 * - when a presence check (every tick until it connects, the first tick after this service
 *   starts, and every 30 s while connected) finds it gone: a webhook missed is not a call kept
 *   open forever. Asking until it connects also covers a client that connected before it handed
 *   its delay over, which no `participant_joined` will follow.
 *
 * LiveKit's server API unreachable: a connected identity keeps being restarted (the webhooks still
 * say when it leaves); a pending one is sent at 30 s. A delay the homeserver no longer has is
 * forgotten. A send that fails is tried again on the next tick and never restarted after.
 *
 * Each leave is kept in the store, so a restart of this service resumes it. The delay id is the
 * one authority over its event, so it never reaches a log.
 */
import type { DelayedLeave, Store } from "../store/index.ts";
import type { CallHomeserver } from "./homeserver.ts";
import type { LiveKit, LiveKitEvent } from "./livekit.ts";

/** The delay a caller arms its leave with (C5): sent this long after the last restart. */
export const LEAVE_DELAY_MS = 8_000;
/**
 * How often a connected identity's delay is restarted. A restart gives up after
 * `DELAYED_EVENT_TIMEOUT_MS`, under this, so two intervals (one failed restart) fit in the delay.
 */
export const RESTART_INTERVAL_MS = 3_000;
/** How long after registering an identity may take to connect before its leave is sent. */
export const CONNECT_GRACE_MS = 30_000;
/** How often a connected identity's presence is asked of LiveKit again. */
export const PRESENCE_RECHECK_MS = 30_000;

export interface DelayedLeavesDeps {
  store: Pick<
    Store,
    | "recordDelayedLeave"
    | "delayedLeaves"
    | "markDelayedLeaveConnected"
    | "forgetDelayedLeave"
  >;
  homeserver: Pick<CallHomeserver, "delayedEvent">;
  livekit: Pick<LiveKit, "isConnected">;
  /** Test seam: the clock, in milliseconds. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface DelayedLeaves {
  /** Keep a caller's delayed leave, replacing any for the same room and identity. */
  register(
    input: Omit<DelayedLeave, "registeredAt" | "connectedAt">,
  ): Promise<void>;
  /** A verified LiveKit webhook. */
  onEvent(event: LiveKitEvent): Promise<void>;
  /**
   * One pass over every kept leave: it starts each leave's due work (a restart, a presence check, a
   * send) that is not already under way, and settles when the work it started has. Work still
   * under way from an earlier pass is not started again.
   */
  tick(): Promise<void>;
  /**
   * Tick now, then every `RESTART_INTERVAL_MS`, on time whether or not a pass has finished.
   * `schedule` is the test seam: it runs `run` after `ms` and answers how to cancel that.
   */
  start(options?: {
    schedule?: (run: () => void, ms: number) => () => void;
  }): void;
  stop(): void;
}

const where = (leave: DelayedLeave) =>
  `${leave.identity} in ${leave.livekitRoom}`;

/** `setTimeout`, answering how to cancel it. */
function later(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

async function settled(work: Promise<void>[]): Promise<void> {
  await Promise.all(work);
}

export function createDelayedLeaves(deps: DelayedLeavesDeps): DelayedLeaves {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** When presence was last asked, by delay id; absent after a restart, so the first tick asks. */
  const checkedAt = new Map<string, number>();
  /** The LiveKit session (participant sid) each delay's identity last joined with, by delay id. */
  const sessions = new Map<string, string>();
  /** Delays whose send failed: sent again, never restarted. */
  const leaving = new Set<string>();
  /** Work under way, by kind and delay id: one of each at a time for a leave. */
  const underWay = {
    restart: new Set<string>(),
    presence: new Set<string>(),
    send: new Set<string>(),
  };
  let stopped = false;
  let cancel: (() => void) | null = null;

  function forget(leave: DelayedLeave): void {
    deps.store.forgetDelayedLeave(
      leave.livekitRoom,
      leave.identity,
      leave.delayId,
    );
    checkedAt.delete(leave.delayId);
    leaving.delete(leave.delayId);
    sessions.delete(leave.delayId);
  }

  /** Is it in the room? null when LiveKit cannot say. */
  async function present(leave: DelayedLeave): Promise<boolean | null> {
    checkedAt.set(leave.delayId, now());
    try {
      return await deps.livekit.isConnected(leave.livekitRoom, leave.identity);
    } catch {
      return null;
    }
  }

  /** Run `work` for this leave unless that kind of work is already under way for it. */
  async function once(
    kind: keyof typeof underWay,
    leave: DelayedLeave,
    work: () => Promise<void>,
  ): Promise<void> {
    const busy = underWay[kind];
    if (busy.has(leave.delayId)) return;
    busy.add(leave.delayId);
    try {
      await work();
    } finally {
      busy.delete(leave.delayId);
    }
  }

  function send(leave: DelayedLeave, why: string): Promise<void> {
    leaving.add(leave.delayId);
    return once("send", leave, () => sendNow(leave, why));
  }

  async function sendNow(leave: DelayedLeave, why: string): Promise<void> {
    try {
      await deps.homeserver.delayedEvent(leave.delayId, "send");
      forget(leave);
      log(`superdial: ${where(leave)} ${why}; its leave was sent`);
    } catch {
      log(
        `superdial: the leave of ${where(leave)} could not be sent; it is tried again`,
      );
    }
  }

  function restart(leave: DelayedLeave): Promise<void> {
    return once("restart", leave, () => restartNow(leave));
  }

  async function restartNow(leave: DelayedLeave): Promise<void> {
    if (leaving.has(leave.delayId)) return;
    try {
      if (
        (await deps.homeserver.delayedEvent(leave.delayId, "restart")) ===
        "gone"
      ) {
        forget(leave);
        log(
          `superdial: the homeserver no longer has the leave of ${where(leave)}; it is forgotten`,
        );
      }
    } catch {
      log(
        `superdial: the leave of ${where(leave)} could not be restarted; it is tried again`,
      );
    }
  }

  /** Start this leave's due work; settles when that work has. */
  function visit(leave: DelayedLeave): Promise<void> {
    if (leaving.has(leave.delayId)) return send(leave, "left");
    if (leave.connectedAt === null) {
      return once("presence", leave, async () => {
        if ((await present(leave)) === true) {
          deps.store.markDelayedLeaveConnected(
            leave.livekitRoom,
            leave.identity,
            leave.delayId,
          );
          return restart(leave);
        }
        if (now() - Date.parse(leave.registeredAt) >= CONNECT_GRACE_MS) {
          return send(leave, "never connected");
        }
      });
    }
    // Restarted first, and not after the presence check: a slow LiveKit must not let it fire.
    const work = [restart(leave)];
    const last = checkedAt.get(leave.delayId);
    if (last === undefined || now() - last >= PRESENCE_RECHECK_MS) {
      work.push(
        once("presence", leave, async () => {
          if ((await present(leave)) === false) await send(leave, "is gone");
        }),
      );
    }
    return settled(work);
  }

  async function pass(): Promise<void> {
    await Promise.all(deps.store.delayedLeaves().map(visit));
  }

  function matching(event: LiveKitEvent): DelayedLeave[] {
    if (event.room === null) return [];
    return deps.store
      .delayedLeaves()
      .filter(
        (l) =>
          l.livekitRoom === event.room &&
          (event.event === "room_finished" || l.identity === event.identity),
      );
  }

  /** A `participant_left` or `participant_connection_aborted` for this leave's identity. */
  async function left(leave: DelayedLeave, event: LiveKitEvent): Promise<void> {
    const known = sessions.get(leave.delayId);
    const sid = event.participantSid ?? null;
    if (known !== undefined && sid !== null && sid !== known) {
      log(
        `superdial: an earlier session of ${where(leave)} ended; its leave is kept`,
      );
      return;
    }
    if ((await present(leave)) === true) {
      log(
        `superdial: ${where(leave)} is still in the room after a session ended; its leave is kept`,
      );
      return;
    }
    await send(leave, "left");
  }

  const leaves: DelayedLeaves = {
    register(input) {
      // Not connected until LiveKit says so: a client that connected before it handed its delay
      // over gets no webhook after, so the next tick asks LiveKit.
      const leave = deps.store.recordDelayedLeave(input);
      checkedAt.delete(leave.delayId);
      leaving.delete(leave.delayId);
      return Promise.resolve();
    },

    async onEvent(event) {
      switch (event.event) {
        case "participant_joined":
          for (const leave of matching(event)) {
            deps.store.markDelayedLeaveConnected(
              leave.livekitRoom,
              leave.identity,
              leave.delayId,
            );
            checkedAt.set(leave.delayId, now());
            if (event.participantSid) {
              sessions.set(leave.delayId, event.participantSid);
            }
          }
          return;
        case "participant_left":
        case "participant_connection_aborted":
          await Promise.all(matching(event).map((l) => left(l, event)));
          return;
        case "room_finished":
          await Promise.all(
            matching(event).map((l) => send(l, "was in a room that finished")),
          );
          return;
        default:
          return;
      }
    },

    tick() {
      return pass();
    },

    start(options = {}) {
      const schedule = options.schedule ?? later;
      stopped = false;
      const run = () => {
        if (stopped) return;
        // The next pass is set before this one runs, so a slow pass never delays it.
        cancel = schedule(run, RESTART_INTERVAL_MS);
        leaves.tick().catch(() => {
          log(
            "superdial: a delayed-leave pass failed; the next one runs on time",
          );
        });
      };
      run();
    },

    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
  return leaves;
}
