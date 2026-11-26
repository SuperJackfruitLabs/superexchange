import { afterEach, describe, expect, test } from "bun:test";
import {
  CONNECT_GRACE_MS,
  CallUpstreamError,
  PRESENCE_RECHECK_MS,
  RESTART_INTERVAL_MS,
  createDelayedLeaves,
} from "../src/calls/index.ts";
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

/** A loop over a real store, a fake clock, a fake homeserver and a fake LiveKit. */
function setup(
  options: {
    present?: (room: string, identity: string) => boolean | "throw";
    action?: (delayId: string, action: string) => "ok" | "gone" | "throw";
    store?: Store;
  } = {},
) {
  const clock = { t: Date.parse("2026-11-27T10:00:00.000Z") };
  const store =
    options.store ??
    (() => {
      const s = tempStore(() => new Date(clock.t));
      cleanups.push(s.cleanup);
      return s.store;
    })();
  const actions: Array<[string, string]> = [];
  const presenceAsked: string[] = [];
  const { log, lines } = captureLog();
  const leaves = createDelayedLeaves({
    store,
    homeserver: {
      delayedEvent: (delayId, action) => {
        actions.push([delayId, action]);
        const answer = options.action?.(delayId, action) ?? "ok";
        if (answer === "throw") {
          return Promise.reject(new CallUpstreamError("homeserver", "down"));
        }
        return Promise.resolve(answer);
      },
    },
    livekit: {
      isConnected: (room, identity) => {
        presenceAsked.push(identity);
        const answer = options.present?.(room, identity) ?? false;
        if (answer === "throw") {
          return Promise.reject(new CallUpstreamError("livekit", "down"));
        }
        return Promise.resolve(answer);
      },
    },
    now: () => clock.t,
    log,
  });
  const advance = (ms: number) => {
    clock.t += ms;
  };
  return { store, leaves, actions, presenceAsked, lines, advance, clock };
}

describe("calls: the delayed-leave loop", () => {
  test("the timings are C5's", () => {
    expect(RESTART_INTERVAL_MS).toBe(5000);
    expect(CONNECT_GRACE_MS).toBe(30000);
    expect(PRESENCE_RECHECK_MS).toBe(30000);
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
      present: () => true,
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
    expect(after.actions.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["syd_2", "send"],
      ["syd_secret_1", "restart"],
    ]);
    expect(store.delayedLeaves().map((l) => l.delayId)).toEqual([
      "syd_secret_1",
    ]);
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

  test("start ticks now and every 5 s, and stop ends it", async () => {
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
