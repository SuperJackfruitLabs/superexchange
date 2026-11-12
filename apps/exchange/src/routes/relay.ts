/**
 * `POST /v1/relay/events`: the suite's event relay delivering an event this service subscribes
 * to (charter decision 2026-11-11, "SuperExchange takes gates from the event relay").
 *
 * Each delivery is a CloudEvent in HTTP binary mode, signed in `x-treaty-signature` over the
 * timestamp, the event id and the exact body. The signature is checked with treaty's
 * `verifyDelivery` before the data is read.
 *
 * - not a CloudEvent: 400, before the signature is checked (there is no id to check it over);
 * - a bad, stale or missing signature: 401;
 * - any type but `gate.pending` v1 and `elicitation.pending` v1: 200 `{status:"ignored"}`, so the
 *   relay does not retry what this build will never handle;
 * - a `gate.pending` whose data is not a gate, or an `elicitation.pending` whose data is not a
 *   question: 400;
 * - a gate or question for an opted-in, enabled board: recorded once, 200 `{status:"accepted"}`,
 *   and handed to board chat to post (a redelivery too: one not yet posted is tried again);
 * - a gate or question for any other board, and an approval request for a board outside this
 *   service's workspace (`approvalRequestAllowed`; absent, none is kept): 200 `{status:"ignored"}`.
 */
import {
  SIGNATURE_HEADER,
  fromBinary,
  verifyDelivery,
} from "@superjackfruitlabs/treaty-cloudevents";
import {
  ELICITATION_PENDING_V1,
  GATE_PENDING_V1,
  intakeGate,
  intakeQuestion,
  type ApprovalRequestAllowed,
} from "../board-chat/index.ts";
import type { Store } from "../store/index.ts";
import { readBody, tooLarge } from "./body.ts";

export const RELAY_EVENTS_PATH = "/v1/relay/events";

/** The largest delivery accepted. A gate is a few kilobytes. */
export const MAX_RELAY_BODY = 256 * 1024;

export interface RelayDeps {
  /** The secret the relay signs this service's deliveries with. */
  secret: string;
  store: Pick<
    Store,
    "getBoard" | "recordGateDelivery" | "recordQuestionDelivery"
  >;
  log?: (line: string) => void;
  /** Told of each accepted gate (new or redelivered), to post it. Must not throw or wait. */
  onGateAccepted?: (gateId: string) => void;
  /** Told of each accepted question (new or redelivered), to post it. Must not throw or wait. */
  onQuestionAccepted?: (elicitationId: string) => void;
  /** May an approval request on this board be kept? Absent: never. */
  approvalRequestAllowed?: ApprovalRequestAllowed;
  /** Test seam for the signature's clock. */
  nowMs?: () => number;
}

export function createRelayHandler(deps: RelayDeps) {
  const log = deps.log ?? console.log;
  return async (request: Request): Promise<Response> => {
    const bytes = await readBody(request, MAX_RELAY_BODY);
    if (bytes === null) return tooLarge();

    let attributes: Record<string, string>;
    try {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      attributes = fromBinary({ headers, body: bytes }, "http").attributes;
    } catch {
      return Response.json({ error: "not a CloudEvent" }, { status: 400 });
    }
    const id = attributes.id ?? "";

    try {
      await verifyDelivery(
        deps.secret,
        request.headers.get(SIGNATURE_HEADER),
        id,
        bytes,
        deps.nowMs ? { nowMs: deps.nowMs() } : {},
      );
    } catch {
      log(`relay: event ${JSON.stringify(id)} refused: bad signature`);
      return Response.json({ error: "bad signature" }, { status: 401 });
    }

    const type = attributes.type;
    if (type !== GATE_PENDING_V1 && type !== ELICITATION_PENDING_V1) {
      return Response.json({ status: "ignored" });
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return Response.json({ error: "not JSON" }, { status: 400 });
    }

    if (type === ELICITATION_PENDING_V1) {
      const intake = await intakeQuestion(
        deps.store,
        body,
        deps.approvalRequestAllowed,
      );
      if (intake.status === "invalid") {
        log(`relay: event ${JSON.stringify(id)} refused: not a question`);
        return Response.json({ error: "not a question" }, { status: 400 });
      }
      if (intake.status === "ignored") {
        return Response.json({ status: "ignored" });
      }
      log(
        `relay: question ${JSON.stringify(intake.elicitationId)} for ${intake.boardId} ${intake.duplicate ? "already recorded" : "recorded"}`,
      );
      deps.onQuestionAccepted?.(intake.elicitationId);
      return Response.json({ status: "accepted" });
    }
    const intake = intakeGate(deps.store, body);
    if (intake.status === "invalid") {
      log(`relay: event ${JSON.stringify(id)} refused: not a gate`);
      return Response.json({ error: "not a gate" }, { status: 400 });
    }
    if (intake.status === "ignored") {
      return Response.json({ status: "ignored" });
    }
    log(
      `relay: gate ${JSON.stringify(intake.gateId)} for ${intake.boardId} ${intake.duplicate ? "already recorded" : "recorded"}`,
    );
    deps.onGateAccepted?.(intake.gateId);
    return Response.json({ status: "accepted" });
  };
}
