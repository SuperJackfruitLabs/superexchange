import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store/index.ts";

/** A store in a fresh temporary directory, removed by `cleanup`. */
export function tempStore(now?: () => Date): {
  dir: string;
  store: Store;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "superexchange-test-"));
  const store = openStore(dir, now ? { now } : {});
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collects log lines, so a test can say what never reached one. */
export function captureLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

export const OPERATOR_TOKEN = "operator-token-for-tests";
export const OPERATOR_TOKEN_SHA256 = new Bun.CryptoHasher("sha256")
  .update(OPERATOR_TOKEN)
  .digest("hex");
export const HS_TOKEN = "hs-token-for-tests";
export const RELAY_SECRET = "relay-secret-for-tests";

/** A gate.pending body as SuperPipeline publishes it. */
export function gateBody(overrides: Record<string, unknown> = {}) {
  return {
    event: "gate.pending",
    boardId: "brd_7c1f",
    cardId: "crd_8a40",
    gateId: "gte_1",
    stageKey: "review",
    returnStageKey: "build",
    cardTitle: "Ship the release",
    producedBy: "agent",
    options: [
      { id: "approve", label: "Approve" },
      { id: "request_changes", label: "Request changes" },
      { id: "reject", label: "Reject" },
    ],
    ts: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}
