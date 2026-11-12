/**
 * The way back: a person's answer to a gate card becomes a resolution at SuperPipeline, and the
 * receipt that says the board accepted it.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-decision.ts` (`handleGateDecision`,
 * `settleGateOutcome`) and the routing in `matrix-as/inbound.ts`. The parsing and the receipt's
 * content are treaty's (`parseGateDecision`, `gateOutcomeBody`, `gateOutcomeContent`); judging
 * an answer against what was posted, and acting on it, are this service's.
 *
 * This is the one path where a message in a room becomes authority somewhere else, so it fails
 * closed at every step. An answer counts only when:
 *
 * 1. it is a gate decision (v1 or v2) by treaty's parse, an `m.reference` to what it answers;
 * 2. its sender is outside this service's own namespace (`@superexchange_…`);
 * 3. it was said in a board room this service owns;
 * 4. it names a gate this service posted, in that same room, and references that gate's card or
 *    its prose: both identifiers, checked against each other;
 * 5. the gate's board is still opted in and enabled here (a board that left belongs to the other
 *    projector, as the hub ignores the old room of a board that moved);
 * 6. the organization plane links the sender to a principal, and that principal is a person: a
 *    linked agent answering another agent's gate would satisfy a human approval gate with a
 *    machine (agentpod#608);
 * 7. a gate.v2 answer names an option the gate offered, with a comment where it needs one, bound
 *    to the subject (or one of the variants) the card showed in full;
 * 8. no other answer holds or has used the gate's outcome (`outcome_claimed_at`).
 *
 * Then the plane asserts the sender for SuperPipeline (its `sub` must be the principal resolved
 * above), the board resolves the gate as that person, and one receipt is posted: the prose line
 * and the `GATE_OUTCOME_TYPE` event pointing at the card. A refusal the board gives back leaves the
 * gate open and the outcome claim given back, except `GATE_NOT_PENDING`, which says it is closed.
 *
 * Steps 1 to 6 refuse silently, as the hub does, except a plane that cannot be reached: a person
 * who tapped Approve and saw nothing would tap again or give up, so that is said in the room. A
 * stranger or an agent can never make this service speak.
 */
import {
  GATE_OUTCOME_TYPE,
  gateOutcomeBody,
  gateOutcomeContent,
  parseGateDecision,
  type ParsedGateDecision,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { AppserviceClient, MatrixEvent } from "../appservice/index.ts";
import type {
  GateEvent,
  GateOffer,
  GateOfferVariant,
  Store,
} from "../store/index.ts";
import {
  AccountsError,
  type Accounts,
  type SenderPrincipal,
} from "./accounts.ts";
import { gateTxnId } from "./gate-card.ts";
import {
  NAMESPACE_USER_PREFIX,
  describe as describeClientError,
} from "./rooms.ts";
import type { ResolveInput, ResolveResult } from "./superpipeline.ts";

/** What a person is told when the organization plane cannot say who they are. */
export const IDENTITY_UNAVAILABLE_TEXT =
  "I cannot check who you are right now — the account service is unreachable. Nothing has changed; try again in a minute.";

/** What a person is told when the gate was already decided. */
export const ALREADY_DECIDED_TEXT =
  "That was already decided — the board has it.";

/** Why an answer was not acted on and nothing was said. */
export type AnswerIgnored =
  | "not-a-decision"
  | "own-namespace"
  | "not-a-board-room"
  | "unknown-gate"
  | "reference-mismatch"
  | "board-disabled";

/** Why an answer was refused. */
export type AnswerRefusal =
  | "identity-unavailable"
  | "unlinked-sender"
  | "not-human"
  | "already-decided"
  | "bad-option"
  | "comment-required"
  | "subject-missing"
  | "preview-incomplete"
  | "variant-unknown"
  | "variant-incomplete"
  | "variant-expired"
  | "assertion-refused"
  | "subject-mismatch"
  | "subject-expired"
  | "quorum-already-approved"
  | "decider-not-allowed"
  | "release-after-expiry"
  | "board-refused";

export type AnswerOutcome =
  | { status: "ignored"; reason: AnswerIgnored }
  | { status: "refused"; reason: AnswerRefusal }
  /** A quorum gate's approval the board took, which does not by itself pass the gate. */
  | { status: "recorded" }
  | { status: "resolved" };

export interface GateAnswersDeps {
  store: Pick<
    Store,
    | "boardRoomByRoomId"
    | "gateEvent"
    | "getBoard"
    | "claimGateOutcome"
    | "releaseGateOutcome"
    | "claimGateReceipt"
    | "releaseUnfinishedOutcomes"
  >;
  client: Pick<AppserviceClient, "sendEvent">;
  /** Who speaks in board rooms. */
  speaker: string;
  accounts: Pick<Accounts, "principalForMatrixId">;
  /** Resolve the gate at SuperPipeline as the person (`resolveGateAtSuperpipeline`). */
  resolveGate(input: ResolveInput): Promise<ResolveResult>;
  log: (line: string) => void;
  now?: () => Date;
}

export interface GateAnswers {
  /** Is this event a gate answer, by treaty's parse? Only those are handed to `handle`. */
  isAnswer(event: MatrixEvent): boolean;
  handle(event: MatrixEvent): Promise<AnswerOutcome>;
  /** At boot: give back outcome claims a stopped run left mid-answer. */
  resume(): void;
}

export function createGateAnswers(deps: GateAnswersDeps): GateAnswers {
  const { store, log } = deps;
  const now = deps.now ?? (() => new Date());

  const say = (roomId: string, txnId: string, body: string) =>
    deps.client.sendEvent(deps.speaker, roomId, "m.room.message", txnId, {
      msgtype: "m.text",
      body,
    });

  async function handle(event: MatrixEvent): Promise<AnswerOutcome> {
    const ignored = (reason: AnswerIgnored): AnswerOutcome => ({
      status: "ignored",
      reason,
    });
    if (event.type !== "m.room.message") return ignored("not-a-decision");
    const parsed = parseGateDecision(event.content);
    const { sender, room_id: roomId } = event;
    if (
      parsed === null ||
      typeof sender !== "string" ||
      typeof roomId !== "string"
    )
      return ignored("not-a-decision");
    if (sender.startsWith(NAMESPACE_USER_PREFIX))
      return ignored("own-namespace");
    if (store.boardRoomByRoomId(roomId) === null)
      return ignored("not-a-board-room");

    const gate = store.gateEvent(parsed.gateId);
    const at = `gate ${JSON.stringify(parsed.gateId)}`;
    // A gate this service posted, in this room: an answer in one room cannot act on another's.
    if (gate === null || gate.roomId !== roomId) {
      log(
        `board-chat: an answer names ${at}, which was not posted in that room; ignored`,
      );
      return ignored("unknown-gate");
    }
    // Both identifiers, checked against each other: trusting the reference alone would resolve
    // whatever gate a sender pointed at; trusting gate_id alone would let a sender name a gate
    // they never saw. Either of the gate's two events may be the one answered.
    const referenced = parsed.referencedEventId;
    if (
      referenced === null ||
      (referenced !== gate.cardEventId && referenced !== gate.proseEventId)
    ) {
      log(`board-chat: an answer to ${at} references another event; ignored`);
      return ignored("reference-mismatch");
    }
    const board = store.getBoard(gate.boardId);
    if (board === null || !board.enabled) {
      log(
        `board-chat: an answer to ${at} is on a board no longer opted in; ignored`,
      );
      return ignored("board-disabled");
    }

    // Each reply to this answer is sent under its event's id: a redelivered answer says it once.
    const replyTxn = `superexchange.answer.${event.event_id ?? crypto.randomUUID()}`;
    const reply = (body: string) => say(roomId, replyTxn, body);

    let principal: SenderPrincipal | null;
    try {
      principal = await deps.accounts.principalForMatrixId(sender);
    } catch (error) {
      log(
        `board-chat: an answer to ${at}: the sender could not be looked up (${describe(error)})`,
      );
      await reply(IDENTITY_UNAVAILABLE_TEXT);
      return refused("identity-unavailable");
    }
    if (principal === null) {
      // Somebody unlinked in the room is not an error: dropped, not answered.
      log(`board-chat: an answer to ${at} from an unlinked sender; ignored`);
      return refused("unlinked-sender");
    }
    if (principal.kind !== "human") {
      // Warned rather than dropped quietly: an agent trying to answer a gate is worth seeing.
      log(
        `board-chat: a ${JSON.stringify(principal.kind.slice(0, 20))} principal tried to answer ${at}; refused`,
      );
      return refused("not-human");
    }

    // After attribution, so a stranger or an agent cannot make this service speak.
    const offer = gate.offer;
    if (
      parsed.version === 1 &&
      offer?.variants &&
      parsed.optionId === "approve"
    ) {
      await reply(
        "Choose a version in an updated app or on the board. Nothing has changed.",
      );
      return refused("subject-missing");
    }
    if (parsed.version === 2) {
      const refusal = v2Refusal(parsed, offer, now());
      if (refusal) {
        log(
          `board-chat: an answer to ${at} refused before the board (${refusal.reason})`,
        );
        await reply(refusal.text);
        return refused(refusal.reason);
      }
    }

    // One answer acts: the claim is taken before the board is asked, and given back only when the
    // board leaves the gate open.
    if (!store.claimGateOutcome(parsed.gateId)) {
      await reply(ALREADY_DECIDED_TEXT);
      return refused("already-decided");
    }

    const option = offer?.options.find((o) => o.id === parsed.optionId);
    const approving =
      option?.meaning === "approve" || parsed.optionId === "approve";
    const chosen = chosenVariant(parsed.subject, offer?.variants);
    // On a choice gate the binding is the choice, carried only with an approval; request changes
    // and reject act on the whole set, and a stale binding beside them must not be refused.
    const binding = offer?.variants
      ? option?.meaning === "approve" && chosen
        ? parsed.subject
        : null
      : parsed.subject;

    let result: ResolveResult;
    try {
      result = await deps.resolveGate({
        boardId: gate.boardId,
        gateId: parsed.gateId,
        decision: parsed.optionId,
        comment: parsed.comment,
        principalId: principal.id,
        senderMxid: sender,
        ...(binding ? { approvalSubject: binding } : {}),
      });
    } catch (error) {
      store.releaseGateOutcome(parsed.gateId);
      throw error;
    }

    if (result.ok) {
      // A quorum gate: the board taking an approval is not the gate passing. The hub reads the
      // gate back to tell; this service does not yet, so the outcome is given back for the next
      // approver and no receipt is claimed.
      if (offer?.quorum && approving) {
        store.releaseGateOutcome(parsed.gateId);
        log(`board-chat: an approval of quorum ${at} was recorded`);
        return { status: "recorded" };
      }
      log(`board-chat: ${at} resolved from chat on ${gate.boardId}`);
      await postReceipt(gate, {
        decision: parsed.optionId,
        decidedBy: principal.label,
        chosen: option?.meaning === "approve" && chosen ? chosen : null,
      });
      return { status: "resolved" };
    }

    // The board closed the gate: no later answer acts. Any other refusal leaves it open.
    if (result.code !== "GATE_NOT_PENDING")
      store.releaseGateOutcome(parsed.gateId);
    log(
      `board-chat: the board did not take an answer to ${at} (${result.code.slice(0, 64)})`,
    );
    const said = refusalFor(result.code, offer?.quorum ?? null);
    if (said.text !== null) await reply(said.text);
    return refused(said.reason);
  }

  /**
   * Say in the room that the board accepted an answer, once. Best effort: the gate IS resolved by
   * now, so a receipt that cannot be posted must not turn the answer into a failure. The receipt
   * is claimed before it is sent, so an answer delivered twice leaves one.
   */
  async function postReceipt(
    gate: GateEvent,
    decided: {
      decision: string;
      decidedBy: string | null;
      chosen: { id: string; label: string } | null;
    },
  ): Promise<void> {
    if (!store.claimGateReceipt(gate.gateId)) return;
    try {
      await say(
        gate.roomId,
        gateTxnId(gate.gateId, "outcome.prose"),
        gateOutcomeBody(decided),
      );
      await deps.client.sendEvent(
        deps.speaker,
        gate.roomId,
        GATE_OUTCOME_TYPE,
        gateTxnId(gate.gateId, "outcome.card"),
        gateOutcomeContent({
          ...decided,
          gateId: gate.gateId,
          boardId: gate.boardId,
          // The card is what a client draws buttons from: the receipt points at it.
          gateEventId: gate.cardEventId ?? gate.proseEventId ?? "",
        }),
      );
    } catch (error) {
      log(
        `board-chat: gate ${JSON.stringify(gate.gateId)} resolved, and its receipt could not be posted (${describe(error)})`,
      );
    }
  }

  return {
    isAnswer: (event) =>
      event.type === "m.room.message" &&
      parseGateDecision(event.content) !== null,
    handle,
    resume() {
      const released = store.releaseUnfinishedOutcomes();
      if (released > 0) {
        log(
          `board-chat: ${released} gate answer(s) left unfinished by the last run were given back`,
        );
      }
    },
  };
}

const refused = (reason: AnswerRefusal): AnswerOutcome => ({
  status: "refused",
  reason,
});

/**
 * Why a gate.v2 answer must not be carried, or null when it may. Checked against what THIS gate
 * offered when it was posted, never a fixed list; the board judges again on its own terms. A gate
 * posted before offers were recorded offered nothing known, so a v2 answer to it is refused.
 */
function v2Refusal(
  parsed: ParsedGateDecision,
  offer: GateOffer | null,
  now: Date,
): { reason: AnswerRefusal; text: string } | null {
  const option = offer?.options.find((o) => o.id === parsed.optionId);
  if (!offer || !option) {
    return {
      reason: "bad-option",
      text: "That is not one of this gate's options. Nothing has changed.",
    };
  }
  if (option.needs_comment && !parsed.comment) {
    return {
      reason: "comment-required",
      text: "That answer needs a comment. Nothing has changed.",
    };
  }
  if (offer.variants)
    return variantRefusal(parsed, option, offer.variants, now);
  if (offer.subjectId && !parsed.subject) {
    return {
      reason: "subject-missing",
      text: "That answer did not say which version it approves. Nothing has changed.",
    };
  }
  // The card could not show everything being approved, so an approval of it is refused here.
  // Request changes and reject stay.
  if (
    offer.subjectId &&
    option.meaning === "approve" &&
    offer.subjectPreviewComplete !== true
  ) {
    return {
      reason: "preview-incomplete",
      text: "The card could not show everything being approved, so it cannot be approved from here. Open the card on the board. Nothing has changed.",
    };
  }
  return null;
}

/** The variant an answer's binding names exactly, by subject id and digest, if any. */
function chosenVariant(
  binding: { id: string; digest: string } | null,
  variants: GateOfferVariant[] | null | undefined,
): GateOfferVariant | null {
  if (!binding || !variants) return null;
  return (
    variants.find(
      (v) => v.subject_id === binding.id && v.digest === binding.digest,
    ) ?? null
  );
}

/**
 * Why an answer to a choice gate must not be carried. An approval is the choice: its binding must
 * name exactly one recorded variant, shown in full and not expired. Request changes and reject act
 * on the whole set and need no binding.
 */
function variantRefusal(
  parsed: ParsedGateDecision,
  option: { meaning: string },
  variants: GateOfferVariant[],
  now: Date,
): { reason: AnswerRefusal; text: string } | null {
  if (option.meaning !== "approve") return null;
  if (!parsed.subject) {
    return {
      reason: "subject-missing",
      text: "That answer did not say which version it chooses. Nothing has changed.",
    };
  }
  const chosen = chosenVariant(parsed.subject, variants);
  if (!chosen) {
    return {
      reason: "variant-unknown",
      text: "That is not one of the versions this gate offers. Nothing has changed.",
    };
  }
  if (!chosen.preview_complete) {
    return {
      reason: "variant-incomplete",
      text: "That version couldn't be shown in full here — choose it on the board. Nothing has changed.",
    };
  }
  const expiresAt = chosen.expires_at ? Date.parse(chosen.expires_at) : NaN;
  // An expiry that cannot be read is not taken as passed: the board judges.
  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
    return {
      reason: "variant-expired",
      text: "That version has expired, so it can no longer be chosen. Nothing has changed.",
    };
  }
  return null;
}

/** What the board's refusal becomes: the reason, and what is said in the room (null: nothing). */
function refusalFor(
  code: string,
  quorum: unknown,
): { reason: AnswerRefusal; text: string | null } {
  switch (code) {
    case "GATE_NOT_PENDING":
      // Answered on the board, or a double tap. The person who tapped is owed the reason.
      return { reason: "already-decided", text: ALREADY_DECIDED_TEXT };
    case "IDENTITY_UNAVAILABLE":
      return {
        reason: "identity-unavailable",
        text: IDENTITY_UNAVAILABLE_TEXT,
      };
    case "ASSERTION_REFUSED":
    case "ASSERTION_MISMATCH":
      return {
        reason: "assertion-refused",
        text: `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`,
      };
    case "APPROVAL_SUBJECT_MISMATCH":
      return {
        reason: "subject-mismatch",
        text: "The board did not accept that: what it approves is not one of this gate's versions, or was replaced. Open the card on the board. Nothing has changed.",
      };
    case "DECISION_EXPIRED":
      return {
        reason: "subject-expired",
        text: "That has expired, so it can no longer be approved. Nothing has changed.",
      };
    case "QUORUM_ALREADY_APPROVED":
      return {
        reason: "quorum-already-approved",
        text: "You have already approved this; it is waiting for other approvers. Nothing has changed.",
      };
    case "APPROVAL_RELEASE_AFTER_EXPIRY":
      return {
        reason: "release-after-expiry",
        text: "That can't be approved: it would go ahead only after what it approves has expired. Nothing has changed.",
      };
  }
  if (code === "APPROVAL_DECIDER_NOT_ALLOWED" && quorum) {
    return {
      reason: "decider-not-allowed",
      text:
        (quorum as { from?: unknown }).from === "admins"
          ? "This gate needs approvals from the workspace's owners and admins, so your approval does not count here. Nothing has changed."
          : "Your approval does not count for this gate: it needs approvals from its named deciders. Nothing has changed.",
    };
  }
  // Anything else (UNREACHABLE, SEPARATION_OF_DUTIES, …) is logged and not said, as the hub does.
  return { reason: "board-refused", text: null };
}

/**
 * An error as a log may carry it: a plane or homeserver error's message (status and code only),
 * or else only the error's name, since a message may quote what it failed on.
 */
function describe(error: unknown): string {
  if (error instanceof AccountsError) return error.message;
  return describeClientError(error);
}
