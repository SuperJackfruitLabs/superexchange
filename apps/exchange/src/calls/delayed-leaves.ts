/**
 * The cleanup after a dead call client (C5; protocol.md, "Ghost memberships").
 *
 * A caller arms an MSC4140 delayed leave (its empty call membership, sent by the homeserver after
 * 8 s unless restarted), then hands its `delay_id` here. While LiveKit has that identity in the
 * room, this restarts the delay every 5 s, so a client that dies without hanging up still leaves
 * the call once LiveKit notices it gone. It sends the delay:
 *
 * - on `participant_left` or `participant_connection_aborted` for that identity, or
 *   `room_finished` for its room;
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

/** How often a connected identity's delay is restarted. The delay itself is 8 s. */
export const RESTART_INTERVAL_MS = 5_000;
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
  /** One pass over every kept leave. A pass already running makes this a no-op. */
  tick(): Promise<void>;
  /** Tick now, then every `RESTART_INTERVAL_MS`. */
  start(options?: {
    schedule?: (run: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  }): void;
  stop(): void;
}

export function createDelayedLeaves(deps: DelayedLeavesDeps): DelayedLeaves {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** When presence was last asked, by delay id; absent after a restart, so the first tick asks. */
  const checkedAt = new Map<string, number>();
  /** Delays whose send failed: sent again, never restarted. */
  const leaving = new Set<string>();
  let running: Promise<void> | null = null;
  let stopped = false;
  let handle: unknown = null;
  let cancel: (handle: unknown) => void = (h) =>
    clearTimeout(h as ReturnType<typeof setTimeout>);

  const where = (leave: DelayedLeave) =>
    `${leave.identity} in ${leave.livekitRoom}`;

  function forget(leave: DelayedLeave): void {
    deps.store.forgetDelayedLeave(
      leave.livekitRoom,
      leave.identity,
      leave.delayId,
    );
    checkedAt.delete(leave.delayId);
    leaving.delete(leave.delayId);
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

  async function send(leave: DelayedLeave, why: string): Promise<void> {
    leaving.add(leave.delayId);
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

  async function restart(leave: DelayedLeave): Promise<void> {
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

  async function visit(leave: DelayedLeave): Promise<void> {
    if (leaving.has(leave.delayId)) return send(leave, "left");
    if (leave.connectedAt === null) {
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
      return;
    }
    const last = checkedAt.get(leave.delayId);
    if (last === undefined || now() - last >= PRESENCE_RECHECK_MS) {
      if ((await present(leave)) === false) return send(leave, "is gone");
    }
    return restart(leave);
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
          }
          return;
        case "participant_left":
        case "participant_connection_aborted":
          await Promise.all(matching(event).map((l) => send(l, "left")));
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
      if (running !== null) return running;
      running = pass().finally(() => {
        running = null;
      });
      return running;
    },

    start(options = {}) {
      const schedule =
        options.schedule ??
        ((run: () => void, ms: number) => setTimeout(run, ms));
      if (options.cancel) cancel = options.cancel;
      stopped = false;
      const run = async () => {
        try {
          await leaves.tick();
        } catch {
          log(
            "superdial: a delayed-leave pass failed; the next one runs on time",
          );
        }
        if (!stopped) handle = schedule(() => void run(), RESTART_INTERVAL_MS);
      };
      void run();
    },

    stop() {
      stopped = true;
      if (handle !== null) cancel(handle);
      handle = null;
    },
  };
  return leaves;
}
