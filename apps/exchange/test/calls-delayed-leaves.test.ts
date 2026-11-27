import { afterEach, describe, expect, test } from "bun:test";
import {
  CONNECT_GRACE_MS,
  CallUpstreamError,
  EVENT_IDS_KEPT,
  EVENT_ID_WINDOW_MS,
  LEAVE_DELAY_MS,
  PRESENCE_RECHECK_MS,
  RESTART_INTERVAL_MS,
  createDelayedLeaves,
} from "../src/calls/index.ts";
import { DELAYED_EVENT_TIMEOUT_MS } from "../src/calls/homeserver.ts";
import { LIVEKIT_API_TIMEOUT_MS } from "../src/calls/livekit.ts";
import type { Store } from "../src/store/index.ts";
import { captureLog, tempStore } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const LEAVE = {
  livekitRoom: "lk_a",
  identity: "@u:s:DEV",
  userId: "@u:s",
  roomId: "!r:s",
  delayId: "syd_secret_1",
};

type Answer<T> = T | "throw" | Promise<T>;

/**
 * Virtual time over `clock`: a timer runs, and the clock moves, only inside `runUntil`, and each
 * timer's run is followed by every promise it settles.
 */
function virtualTime(clock: { t: number }) {
  const timers: Array<{ at: number; seq: number; run: () => void }> = [];
  let seq = 0;
  const schedule = (run: () => void, ms: number) => {
    const timer = { at: clock.t + ms, seq: seq++, run };
    timers.push(timer);
    return () => {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  /** A promise that settles `ms` from now: with `value`, or rejected with `error`. */
  const after = <T>(ms: number, outcome: { value: T } | { error: Error }) =>
    new Promise<T>((resolve, reject) => {
      schedule(() => {
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      }, ms);
    });
  async function runUntil(end: number): Promise<void> {
    for (;;) {
      await Bun.sleep(0);
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers[0];
      if (next === undefined || next.at > end) break;
      timers.shift();
      clock.t = next.at;
      next.run();
    }
    clock.t = end;
  }
  return { schedule, after, runUntil };
}

/** A loop over a real store, a fake clock, a fake homeserver and a fake LiveKit. */
function setup(
  options: {
    present?: (room: string, identity: string) => Answer<boolean>;
    action?: (delayId: string, action: string) => Answer<"ok" | "gone">;
    store?: Store;
    clock?: { t: number };
  } = {},
) {
  const clock = options.clock ?? { t: Date.parse("2026-11-27T10:00:00.000Z") };
  const store =
    options.store ??
    (() => {
      const s = tempStore(() => new Date(clock.t));
      cleanups.push(s.cleanup);
      return s.store;
    })();
  const actions: Array<[string, string]> = [];
  /** Each action the homeserver carried out, with when it was asked for. */
  const done: Array<{ delayId: string; action: string; at: number }> = [];
  const presenceAsked: string[] = [];
  const { log, lines } = captureLog();
  const leaves = createDelayedLeaves({
    store,
    homeserver: {
      delayedEvent: async (delayId, action) => {
        actions.push([delayId, action]);
        const at = clock.t;
        const answer = await (options.action?.(delayId, action) ?? "ok");
        if (answer === "throw") {
          throw new CallUpstreamError("homeserver", "down");
        }
        done.push({ delayId, action, at });
        return answer;
      },
    },
    livekit: {
      isConnected: async (room, identity) => {
        presenceAsked.push(identity);
        const answer = await (options.present?.(room, identity) ?? false);
        if (answer === "throw") throw new CallUpstreamError("livekit", "down");
        return answer;
      },
    },
    now: () => clock.t,
    log,
  });
  const advance = (ms: number) => {
    clock.t += ms;
  };
  return { store, leaves, actions, done, presenceAsked, lines, advance, clock };
}

/** A webhook about LEAVE's identity in one of its sessions. */
const sessionEvent = (name: string, participantSid: string) => ({
  event: name,
  room: "lk_a",
  identity: "@u:s:DEV",
  participantSid,
});

/** A `participant_left` for LEAVE's identity in session PA_A, with webhook id `id`. */
const leftAs = (id: string) => ({
  ...sessionEvent("participant_left", "PA_A"),
  id,
});

describe("calls: the delayed-leave loop", () => {
  test("the timings: a restart that times out still leaves the next one inside the delay", () => {
    expect(LEAVE_DELAY_MS).toBe(8000);
    expect(RESTART_INTERVAL_MS).toBe(3000);
    expect(CONNECT_GRACE_MS).toBe(30000);
    expect(PRESENCE_RECHECK_MS).toBe(30000);
    // A restart gives up before the next is due, so it never holds that one back; and one failed
    // restart still leaves the next inside the delay.
    expect(DELAYED_EVENT_TIMEOUT_MS).toBeLessThanOrEqual(2500);
    expect(LIVEKIT_API_TIMEOUT_MS).toBeLessThanOrEqual(2500);
    expect(DELAYED_EVENT_TIMEOUT_MS).toBeLessThan(RESTART_INTERVAL_MS);
    expect(2 * RESTART_INTERVAL_MS).toBeLessThan(LEAVE_DELAY_MS);
  });

  test("restarts keep their cadence while LiveKit's API hangs and one restart hangs", async () => {
    const clock = { t: Date.parse("2026-11-27T10:00:00.000Z") };
    const vt = virtualTime(clock);
    let hung = false;
    const s = setup({
      clock,
      // LiveKit's server API blackholed: every presence check waits out its timeout.
      present: () =>
        vt.after<boolean>(LIVEKIT_API_TIMEOUT_MS, {
          error: new CallUpstreamError("livekit", "timed out"),
        }),
      action: (delayId, action) => {
        if (action === "restart" && delayId === "syd_2" && !hung) {
          // The homeserver sits on one restart until it times out.
          hung = true;
          return vt.after<"ok">(DELAYED_EVENT_TIMEOUT_MS, {
            error: new CallUpstreamError("homeserver", "timed out"),
          });
        }
        return vt.after(50, { value: "ok" as const });
      },
    });
    // Connected before this loop started (as after a restart of the service), so the first pass
    // asks LiveKit about each of them, and every one of those checks hangs.
    for (const [identity, delayId] of [
      ["@u:s:DEV", "syd_secret_1"],
      ["@v:s:D2", "syd_2"],
      ["@w:s:D3", "syd_3"],
    ] as const) {
      s.store.recordDelayedLeave({ ...LEAVE, identity, delayId });
      s.store.markDelayedLeaveConnected("lk_a", identity, delayId);
    }
    const begin = clock.t;
    s.leaves.start({ schedule: vt.schedule });
    await vt.runUntil(begin + 60_000);
    s.leaves.stop();

    expect(s.presenceAsked.length).toBeGreaterThanOrEqual(3);
    for (const delayId of ["syd_secret_1", "syd_2", "syd_3"]) {
      const at = s.done
        .filter((d) => d.delayId === delayId && d.action === "restart")
        .map((d) => d.at - begin);
      expect(at.length).toBeGreaterThanOrEqual(19);
      const gaps = at.map((t, i) => t - (i === 0 ? 0 : (at[i - 1] ?? 0)));
      // The hung restart costs its own leave one interval, and nobody else's.
      const allowed =
        delayId === "syd_2" ? 2 * RESTART_INTERVAL_MS : RESTART_INTERVAL_MS;
      expect(Math.max(...gaps)).toBeLessThanOrEqual(allowed);
      expect(Math.max(...gaps)).toBeLessThan(LEAVE_DELAY_MS);
    }
    expect(s.actions.some(([, a]) => a === "send")).toBe(false);
  });

  test("a connected leave is restarted before its presence is asked", async () => {
    const order: string[] = [];
    const { store, leaves, actions } = setup({
      present: () => {
        order.push("presence");
        return false;
      },
      action: (_id, action) => {
        order.push(action);
        return "ok";
      },
    });
    store.recordDelayedLeave(LEAVE);
    store.markDelayedLeaveConnected("lk_a", "@u:s:DEV", "syd_secret_1");
    await leaves.tick();
    expect(order).toEqual(["restart", "presence", "send"]);
    expect(actions).toEqual([
      ["syd_secret_1", "restart"],
      ["syd_secret_1", "send"],
    ]);
  });

  test("the next pass is scheduled on time while a pass still hangs", async () => {
    const scheduled: number[] = [];
    const runs: Array<() => void> = [];
    const { store, leaves } = setup({
      present: () => new Promise<boolean>(() => {}),
    });
    store.recordDelayedLeave(LEAVE);
    leaves.start({
      schedule: (run, ms) => {
        scheduled.push(ms);
        runs.push(run);
        return () => {};
      },
    });
    await Bun.sleep(0);
    expect(scheduled).toEqual([RESTART_INTERVAL_MS]);
    runs.at(-1)?.();
    await Bun.sleep(0);
    expect(scheduled).toEqual([RESTART_INTERVAL_MS, RESTART_INTERVAL_MS]);
    leaves.stop();
  });

  test("while LiveKit has the identity connected it is restarted; when it leaves it is sent, once", async () => {
    const { store, leaves, actions, advance } = setup();
    await leaves.register(LEAVE);
    await leaves.tick();
    expect(actions).toEqual([]);
    await leaves.onEvent({
      event: "participant_joined",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    for (let i = 0; i < 3; i++) {
      advance(RESTART_INTERVAL_MS);
      await leaves.tick();
    }
    expect(actions).toEqual([
      ["syd_secret_1", "restart"],
      ["syd_secret_1", "restart"],
      ["syd_secret_1", "restart"],
    ]);
    await leaves.onEvent({
      event: "participant_left",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    expect(actions.at(-1)).toEqual(["syd_secret_1", "send"]);
    expect(store.delayedLeaves()).toEqual([]);
    advance(RESTART_INTERVAL_MS);
    await leaves.tick();
    expect(actions.filter(([, a]) => a === "send")).toHaveLength(1);
    expect(actions).toHaveLength(4);
  });

  test("an aborted connection sends it, and a finished room sends every leave in it", async () => {
    const { store, leaves, actions } = setup();
    await leaves.register(LEAVE);
    await leaves.register({ ...LEAVE, identity: "@v:s:D2", delayId: "syd_2" });
    await leaves.register({ ...LEAVE, livekitRoom: "lk_b", delayId: "syd_3" });
    await leaves.onEvent({
      event: "participant_connection_aborted",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    expect(actions).toEqual([["syd_secret_1", "send"]]);
    await leaves.onEvent({
      event: "room_finished",
      room: "lk_a",
      identity: null,
    });
    expect(actions).toEqual([
      ["syd_secret_1", "send"],
      ["syd_2", "send"],
    ]);
    expect(store.delayedLeaves().map((l) => l.delayId)).toEqual(["syd_3"]);
  });

  test("an identity that never connects is sent once 30 s have passed", async () => {
    const { store, leaves, actions, advance } = setup();
    await leaves.register(LEAVE);
    for (let waited = 0; waited < CONNECT_GRACE_MS - RESTART_INTERVAL_MS; ) {
      advance(RESTART_INTERVAL_MS);
      waited += RESTART_INTERVAL_MS;
      await leaves.tick();
    }
    expect(actions).toEqual([]);
    advance(RESTART_INTERVAL_MS);
    await leaves.tick();
    expect(actions).toEqual([["syd_secret_1", "send"]]);
    expect(store.delayedLeaves()).toEqual([]);
  });

  test("an identity already connected when it registers is restarted, not sent at 30 s", async () => {
    const { leaves, actions, advance } = setup({ present: () => true });
    await leaves.register(LEAVE);
    expect(actions).toEqual([]);
    for (let i = 0; i < 8; i++) {
      advance(RESTART_INTERVAL_MS);
      await leaves.tick();
    }
    expect(actions.every(([, a]) => a === "restart")).toBe(true);
    expect(actions).toHaveLength(8);
  });

  test("a leave LiveKit's webhook missed is found by the presence re-check", async () => {
    let present = true;
    const { store, leaves, actions, advance, presenceAsked } = setup({
      present: () => present,
    });
    await leaves.register(LEAVE);
    await leaves.tick();
    expect(presenceAsked).toEqual(["@u:s:DEV"]);
    advance(RESTART_INTERVAL_MS);
    await leaves.tick();
    // Connected: not asked again before the re-check is due.
    expect(presenceAsked).toEqual(["@u:s:DEV"]);
    present = false;
    for (let i = 0; i < PRESENCE_RECHECK_MS / RESTART_INTERVAL_MS; i++) {
      advance(RESTART_INTERVAL_MS);
      await leaves.tick();
    }
    expect(actions.at(-1)).toEqual(["syd_secret_1", "send"]);
    expect(store.delayedLeaves()).toEqual([]);
  });

  test("LiveKit unreachable: a connected identity keeps being restarted, a pending one is sent at 30 s", async () => {
    const connected = setup({ present: () => "throw" });
    await connected.leaves.register(LEAVE);
    await connected.leaves.onEvent({
      event: "participant_joined",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    for (let i = 0; i < 10; i++) {
      connected.advance(RESTART_INTERVAL_MS);
      await connected.leaves.tick();
    }
    expect(connected.actions).toHaveLength(10);
    expect(connected.actions.every(([, a]) => a === "restart")).toBe(true);

    const pending = setup({ present: () => "throw" });
    await pending.leaves.register(LEAVE);
    pending.advance(CONNECT_GRACE_MS);
    await pending.leaves.tick();
    expect(pending.actions).toEqual([["syd_secret_1", "send"]]);
  });

  test("a delay the homeserver no longer has is forgotten", async () => {
    const { store, leaves, actions } = setup({
      present: () => true,
      action: () => "gone",
    });
    await leaves.register(LEAVE);
    await leaves.tick();
    expect(actions).toEqual([["syd_secret_1", "restart"]]);
    expect(store.delayedLeaves()).toEqual([]);
  });

  test("a send that fails is kept and sent again on the next tick, never restarted", async () => {
    let down = true;
    const { store, leaves, actions, advance } = setup({
      present: () => false,
      action: (_id, action) => (action === "send" && down ? "throw" : "ok"),
    });
    await leaves.register(LEAVE);
    await leaves.onEvent({
      event: "participant_left",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    expect(store.delayedLeaves()).toHaveLength(1);
    down = false;
    advance(RESTART_INTERVAL_MS);
    await leaves.tick();
    expect(actions).toEqual([
      ["syd_secret_1", "send"],
      ["syd_secret_1", "send"],
    ]);
    expect(store.delayedLeaves()).toEqual([]);
  });

  test("after a restart of the service, each kept leave is checked first: connected is restarted, gone is sent", async () => {
    const first = setup();
    const store = first.store;
    store.recordDelayedLeave(LEAVE);
    store.markDelayedLeaveConnected("lk_a", "@u:s:DEV", "syd_secret_1");
    store.recordDelayedLeave({
      ...LEAVE,
      identity: "@v:s:D2",
      delayId: "syd_2",
    });
    store.markDelayedLeaveConnected("lk_a", "@v:s:D2", "syd_2");

    // A fresh loop over the same store, as after a restart.
    const after = setup({
      store,
      present: (_room, identity) => identity === "@u:s:DEV",
    });
    await after.leaves.tick();
    expect(after.presenceAsked.toSorted()).toEqual(["@u:s:DEV", "@v:s:D2"]);
    // Each is restarted before it is asked about, so a slow answer never lets one fire.
    expect(after.actions.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["syd_2", "restart"],
      ["syd_2", "send"],
      ["syd_secret_1", "restart"],
    ]);
    expect(store.delayedLeaves().map((l) => l.delayId)).toEqual([
      "syd_secret_1",
    ]);
  });

  test("a rejoin's stale session leaving does not send the live session's leave", async () => {
    // A full reconnect: LiveKit admits the new session (sid B) under the same identity, removes
    // the old one (sid A) and says that one left. Presence is not what holds the leave back here:
    // LiveKit answers "not there" throughout, so only the session id does.
    const { store, leaves, actions } = setup({ present: () => false });
    await leaves.register(LEAVE);
    await leaves.onEvent(sessionEvent("participant_joined", "PA_A"));
    await leaves.onEvent(sessionEvent("participant_joined", "PA_B"));
    await leaves.onEvent(sessionEvent("participant_left", "PA_A"));
    await leaves.onEvent(
      sessionEvent("participant_connection_aborted", "PA_A"),
    );
    expect(actions).toEqual([]);
    expect(store.delayedLeaves()).toHaveLength(1);
    await leaves.onEvent(sessionEvent("participant_left", "PA_B"));
    expect(actions).toEqual([["syd_secret_1", "send"]]);
    expect(store.delayedLeaves()).toEqual([]);
  });

  test("a leave for a session it never saw join is sent only once LiveKit says the identity is gone", async () => {
    // After a restart of this service, or a joined webhook that never came: no session id is
    // known, so LiveKit is asked whether the identity is still in the room.
    let present = true;
    const { store, leaves, actions } = setup({ present: () => present });
    await leaves.register(LEAVE);
    const left = {
      event: "participant_left",
      room: "lk_a",
      identity: "@u:s:DEV",
      participantSid: "PA_OLD",
    };
    await leaves.onEvent(left);
    expect(actions).toEqual([]);
    expect(store.delayedLeaves()).toHaveLength(1);
    present = false;
    await leaves.onEvent({ ...left, participantSid: "PA_NEW" });
    expect(actions).toEqual([["syd_secret_1", "send"]]);
  });

  test("a leave LiveKit cannot confirm is still sent: the webhook says it left", async () => {
    const { leaves, actions } = setup({ present: () => "throw" });
    await leaves.register(LEAVE);
    await leaves.onEvent({
      event: "participant_left",
      room: "lk_a",
      identity: "@u:s:DEV",
      participantSid: "PA_A",
    });
    expect(actions).toEqual([["syd_secret_1", "send"]]);
  });

  test("a webhook seen before is not acted on again", async () => {
    // A replayed joined for the old session would make the live session's leave look stale.
    const { leaves, actions } = setup({ present: () => false });
    await leaves.register(LEAVE);
    const joinedA = {
      ...sessionEvent("participant_joined", "PA_A"),
      id: "EV_1",
    };
    await leaves.onEvent(joinedA);
    await leaves.onEvent({
      ...sessionEvent("participant_joined", "PA_B"),
      id: "EV_2",
    });
    await leaves.onEvent(joinedA);
    await leaves.onEvent({
      ...sessionEvent("participant_left", "PA_B"),
      id: "EV_3",
    });
    expect(actions).toEqual([["syd_secret_1", "send"]]);
  });

  test("the webhook ids it remembers are bounded, by count and by age", async () => {
    expect(EVENT_IDS_KEPT).toBe(1000);
    expect(EVENT_ID_WINDOW_MS).toBe(600_000);
    // Each left it acts on asks LiveKit once; LiveKit still has the identity, so nothing is sent.
    const { leaves, presenceAsked, advance } = setup({ present: () => true });
    await leaves.register(LEAVE);
    await leaves.onEvent(leftAs("EV_1"));
    await leaves.onEvent(leftAs("EV_1"));
    expect(presenceAsked).toHaveLength(1);
    advance(EVENT_ID_WINDOW_MS);
    await leaves.onEvent(leftAs("EV_1"));
    expect(presenceAsked).toHaveLength(2);
    for (let i = 0; i < EVENT_IDS_KEPT; i++) {
      await leaves.onEvent(leftAs(`EV_other_${i}`));
    }
    expect(presenceAsked).toHaveLength(2 + EVENT_IDS_KEPT);
    await leaves.onEvent(leftAs("EV_1"));
    expect(presenceAsked).toHaveLength(3 + EVENT_IDS_KEPT);
    // An event with no id is never taken for a repeat.
    const { id: _, ...noId } = leftAs("x");
    await leaves.onEvent(noId);
    await leaves.onEvent(noId);
    expect(presenceAsked).toHaveLength(5 + EVENT_IDS_KEPT);
  });

  test("a leave that replaces another drops what was held for the old delay", async () => {
    let failSend = true;
    const { leaves } = setup({
      present: () => false,
      action: (_id, action) => (action === "send" && failSend ? "throw" : "ok"),
    });
    await leaves.register(LEAVE);
    await leaves.onEvent(sessionEvent("participant_joined", "PA_A"));
    // Joined (presence time, session) and a send that failed (kept to send again).
    await leaves.onEvent(sessionEvent("participant_left", "PA_A"));
    expect(leaves.heldInMemory()).toBe(1);
    failSend = false;
    // The client hands over a new delay for the same room and identity.
    await leaves.register({ ...LEAVE, delayId: "syd_new" });
    expect(leaves.heldInMemory()).toBe(0);
  });

  test("an event for an identity it does not keep changes nothing", async () => {
    const { store, leaves, actions } = setup();
    await leaves.register(LEAVE);
    for (const event of [
      { event: "participant_left", room: "lk_a", identity: "@x:s:DEV" },
      { event: "participant_left", room: "lk_other", identity: "@u:s:DEV" },
      { event: "room_finished", room: "lk_other", identity: null },
      { event: "participant_left", room: null, identity: "@u:s:DEV" },
      { event: "track_published", room: "lk_a", identity: "@u:s:DEV" },
    ]) {
      await leaves.onEvent(event);
    }
    expect(actions).toEqual([]);
    expect(store.delayedLeaves()).toHaveLength(1);
  });

  test("ticks never overlap", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let asked = 0;
    const slow = createDelayedLeaves({
      store: (() => {
        const s = tempStore();
        cleanups.push(s.cleanup);
        s.store.recordDelayedLeave(LEAVE);
        return s.store;
      })(),
      homeserver: { delayedEvent: () => Promise.resolve("ok" as const) },
      livekit: {
        isConnected: async () => {
          asked++;
          await gate;
          return true;
        },
      },
    });
    const one = slow.tick();
    const two = slow.tick();
    release();
    await Promise.all([one, two]);
    expect(asked).toBe(1);
  });

  test("start ticks now and every restart interval, and stop ends it", async () => {
    const scheduled: number[] = [];
    const runs: Array<() => void> = [];
    let cancelled = 0;
    const { leaves } = setup();
    leaves.start({
      schedule: (run, ms) => {
        scheduled.push(ms);
        runs.push(run);
        return () => {
          cancelled++;
        };
      },
    });
    await Bun.sleep(0);
    expect(scheduled).toEqual([RESTART_INTERVAL_MS]);
    runs.at(-1)?.();
    await Bun.sleep(0);
    expect(scheduled).toEqual([RESTART_INTERVAL_MS, RESTART_INTERVAL_MS]);
    leaves.stop();
    expect(cancelled).toBe(1);
  });

  test("no log line carries a delay id", async () => {
    const { leaves, lines, advance } = setup({
      action: (_id, action) => (action === "restart" ? "throw" : "ok"),
    });
    await leaves.register(LEAVE);
    await leaves.onEvent({
      event: "participant_joined",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    advance(RESTART_INTERVAL_MS);
    await leaves.tick();
    await leaves.onEvent({
      event: "participant_left",
      room: "lk_a",
      identity: "@u:s:DEV",
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain("syd_secret_1");
  });
});
