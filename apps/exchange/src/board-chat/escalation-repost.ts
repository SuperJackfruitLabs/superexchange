/**
 * Readable after joining: an escalation's card moved below for the workspace admin it invited.
 *
 * Ported from the AgentPod hub's `services/board-chat/decision-repost.ts` (`moveCardBelow`),
 * `checks-waiting.ts` (`moveChecksCardBelow`) and `decision-notices.ts` (`repostEscalationsOnJoin`,
 * `retryEscalationReposts`). A board room is encrypted to the people in it when a message is sent,
 * so an admin an escalation invited cannot read the card posted before they were. When their join is
 * seen, each still-open escalated card on that board is posted again below, the full current
 * envelope rebuilt by treaty's builders from a fresh read of what the board waits on, and **the
 * decision's record moves to the new event**:
 *
 * - The record keeps everything an answer is judged against (options, subject binding, wait id, the
 *   receipt's claim). Only its event moves, and only if the fresh envelope still offers what was
 *   recorded; otherwise nothing moves and the card stays the one that counts.
 * - An answer referencing the old card then fails the reference check and acts on nothing, so the
 *   decision cannot be answered twice. The old card gets a "moved below" reply.
 * - The move is conditional on the record still pointing at the old event and still open: an answer
 *   (or another move) that lands mid-move wins, and the new copy says it does not count.
 *
 * Then the escalation notice is posted again, in reply to the card that counts. If the board cannot
 * be read, only the notice is posted.
 *
 * Bounded: the join is recorded once per board and invitee (`escalation_invites.joined_at`); each
 * escalation is claimed per join (`reposted_at`) and given back when its re-post fails, and the
 * notice retry finishes it, at most `MAX_REPOST_ATTEMPTS` passes per join. Every send is under a
 * transaction id derived from the join and the escalation, so a retry is the same message.
 */
import {
  ELICITATION_REQUEST_CONTENT_KEY,
  GATE_EVENT_TYPE,
  GATE_REQUEST_CONTENT_KEY,
  attentionV2Content,
  boundedQuestion,
  decisionNoticeContent,
  deliveryV2Content,
  elicitationRequestCard,
  gateEventContent,
  gateRequestCard,
  gateV2Content,
  isAttentionPending,
  isDeliveryPending,
  isElicitationPending,
  isGatePending,
  questionV2Content,
  type DecisionTimeoutDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type {
  BoardRoom,
  EscalationInvite,
  GateOffer,
  Notice,
  Store,
} from "../store/index.ts";
import { attentionOffer } from "./attention-card.ts";
import { followupOffer } from "./followup-card.ts";
import { gateOffer } from "./gate-offer.ts";
import {
  checksWaitingCardContent,
  readWaitingChecks,
  type ChecksRead,
} from "./notice-post.ts";
import { decisionCard, hashKey } from "./notices.ts";
import { questionOffer } from "./question-card.ts";
import type { RoomSender } from "./room-sender.ts";
import { describe } from "./rooms.ts";
import type { SuperpipelineReads } from "./superpipeline.ts";

/** Passes at re-posting for one join before it stops being retried. */
export const MAX_REPOST_ATTEMPTS = 5;

export const MOVED_BELOW_TEXT =
  "Moved below, so the workspace admins who just joined can read it. Answer the copy below; this one no longer counts.";
export const SETTLED_ABOVE_TEXT =
  "That one was answered or moved while this copy was being posted; nothing to answer here.";

export type RepostReads = Pick<
  SuperpipelineReads,
  "pendingGates" | "pendingQuestions" | "pendingFollowups" | "pendingAttention"
> &
  ChecksRead;

export interface RepostDeps {
  store: Pick<
    Store,
    | "boardRoom"
    | "postedEscalations"
    | "claimNoticeRepost"
    | "releaseNoticeRepost"
    | "recordNoticeCardMoved"
    | "countRepostAttempt"
    | "recordInviteReposted"
    | "gateEvent"
    | "gateDelivery"
    | "questionEvent"
    | "questionDelivery"
    | "followupEvent"
    | "attentionEvent"
    | "checksWaiting"
    | "moveGateEvent"
    | "moveQuestionEvent"
    | "moveFollowupEvent"
    | "moveAttentionEvent"
    | "moveChecksWaiting"
  >;
  sender: Pick<RoomSender, "sendEvent" | "refusal">;
  speaker: string;
  /** What the board waits on now. Absent: only the notices are posted again. */
  reads?: Partial<RepostReads>;
  log: (line: string) => void;
}

export type MoveOutcome = "moved" | "not-pending" | "changed" | "settled";

/** The transaction id of one part of one escalation's re-post for one join. */
export function repostTxnId(
  invite: Pick<EscalationInvite, "boardId" | "userId">,
  noticeId: string,
  part: "prose" | "card" | "moved" | "settled" | "notice",
): string {
  const key = hashKey([invite.boardId, invite.userId, noticeId]).slice(0, 32);
  return `superexchange.repost.${key}.${part}`;
}

const reply = (eventId: string) => ({
  "m.relates_to": { "m.in_reply_to": { event_id: eventId } },
});

/** A gate's offer as a re-post must still match it: options, and the subject or the variants. */
function gateKey(o: GateOffer | null): string {
  if (o === null) return "";
  return JSON.stringify([
    o.options.map((x) => `${x.id}:${x.meaning}`),
    o.subjectDigest,
    o.variants?.map((v) => `${v.id}@${v.digest}`) ?? null,
  ]);
}

/**
 * Re-post a board's open escalations for an invitee who joined. Run only in board chat's queue.
 * Answers how many notices were posted again.
 */
export async function repostForInvite(
  deps: RepostDeps,
  invite: EscalationInvite,
): Promise<number> {
  const { store, log } = deps;
  const joinedAt = invite.joinedAt ?? new Date().toISOString();
  store.countRepostAttempt(invite.boardId, invite.userId);
  const room = store.boardRoom(invite.boardId);
  if (room === null || deps.sender.refusal(room) !== null) return 0;

  /** One fresh read per kind per pass, and only when there is something to move. */
  const reads = new Map<string, Promise<unknown[] | null>>();
  let reposted = 0;
  let failed = false;
  for (const n of store.postedEscalations(invite.boardId)) {
    const d = n.body as DecisionTimeoutDelivery;
    // Posted again after this admin joined: they can read it.
    if (n.repostedAt !== null && n.repostedAt >= joinedAt) continue;
    const before = decisionCard(
      store,
      d.decisionKind,
      d.decisionId,
      d.boardId,
      d.cardId,
    );
    if (!before?.open || before.roomId !== room.roomId) continue;
    // Claimed before the work, so a join and a retry racing post it once.
    if (!store.claimNoticeRepost(n.noticeId, joinedAt)) continue;
    try {
      // The card moves once per join: a retry after a notice that failed does not post it again.
      if (n.cardMovedAt === null || n.cardMovedAt < joinedAt) {
        const moved =
          d.decisionKind === "checks"
            ? await moveChecksCardBelow(deps, invite, n, d, room)
            : await moveCardBelow(deps, invite, n, d, room, reads);
        if (moved === "moved") store.recordNoticeCardMoved(n.noticeId);
      }
      const card = decisionCard(
        store,
        d.decisionKind,
        d.decisionId,
        d.boardId,
        d.cardId,
      );
      if (!card?.open) continue;
      await deps.sender.sendEvent(
        deps.speaker,
        room.roomId,
        "m.room.message",
        repostTxnId(invite, n.noticeId, "notice"),
        decisionNoticeContent(d, card.eventId),
      );
      reposted++;
    } catch (error) {
      failed = true;
      store.releaseNoticeRepost(n.noticeId, n.repostedAt);
      log(
        `board-chat: an escalation on ${invite.boardId} could not be posted again for a workspace admin who joined (${describe(error)}); it is tried again`,
      );
    }
  }
  if (!failed) store.recordInviteReposted(invite.boardId, invite.userId);
  if (reposted > 0)
    log(
      `board-chat: ${reposted} open escalation(s) on ${invite.boardId} posted again for a workspace admin who joined`,
    );
  return reposted;
}

/** What the board waits on now for this kind, or null when it cannot be read. */
function pendingOf(
  deps: RepostDeps,
  kind: string,
  boardId: string,
  reads: Map<string, Promise<unknown[] | null>>,
): Promise<unknown[] | null> {
  const r = deps.reads;
  const read =
    kind === "gate"
      ? r?.pendingGates
      : kind === "question"
        ? r?.pendingQuestions
        : kind === "delivery"
          ? r?.pendingFollowups
          : r?.pendingAttention;
  if (!read) return Promise.resolve(null);
  let pending = reads.get(kind);
  if (!pending) {
    pending = read(boardId).catch((error: unknown) => {
      deps.log(
        `board-chat: ${boardId} could not be read to move its escalated cards (${describe(error)}); the notices are posted alone`,
      );
      return null;
    });
    reads.set(kind, pending);
  }
  return pending;
}

interface Rebuilt {
  /** The record's event the card is moved from. */
  was: string;
  /** Post the new copy; answers its message (and for a gate, its card event). */
  post(): Promise<{ eventId: string; cardEventId?: string }>;
  /** Move the record, only if it still points at `was` and is open. */
  move(to: { eventId: string; cardEventId?: string }): boolean;
}

/** The decision's fresh envelope, and how to move its record, or why it does not move. */
function rebuild(
  deps: RepostDeps,
  invite: EscalationInvite,
  n: Notice,
  d: DecisionTimeoutDelivery,
  room: BoardRoom,
  pending: unknown[],
): Rebuilt | "not-pending" | "changed" | "settled" {
  const { store, sender, speaker } = deps;
  const send = (
    part: "prose" | "card",
    type: string,
    content: Record<string, unknown>,
  ) =>
    sender.sendEvent(
      speaker,
      room.roomId,
      type,
      repostTxnId(invite, n.noticeId, part),
      content,
    );
  const id = d.decisionId;
  if (d.decisionKind === "gate") {
    const g = store.gateEvent(id);
    if (!g?.postedAt || g.outcomePostedAt !== null) return "settled";
    const fresh = pending.find(
      (p) => isGatePending(p) && p.gateId === id && p.cardId === d.cardId,
    );
    if (!fresh || !isGatePending(fresh)) return "not-pending";
    if (gateKey(gateOffer(fresh)) !== gateKey(g.offer)) return "changed";
    const was = { proseEventId: g.proseEventId, cardEventId: g.cardEventId };
    return {
      was: g.proseEventId ?? g.cardEventId ?? "",
      async post() {
        const eventId = await send("prose", "m.room.message", {
          ...gateV2Content(fresh),
          [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(fresh),
        });
        const cardEventId = await send(
          "card",
          GATE_EVENT_TYPE,
          gateEventContent(fresh),
        );
        return { eventId, cardEventId };
      },
      move: (to) =>
        store.moveGateEvent(id, was, {
          proseEventId: to.eventId,
          cardEventId: to.cardEventId ?? to.eventId,
        }),
    };
  }
  if (d.decisionKind === "question") {
    const q = store.questionEvent(id);
    if (!q?.eventId || q.outcomePostedAt !== null) return "settled";
    const raw = pending.find(
      (p) =>
        isElicitationPending(p) &&
        p.elicitationId === id &&
        p.cardId === d.cardId,
    );
    if (!raw || !isElicitationPending(raw)) return "not-pending";
    const fresh = boundedQuestion(raw);
    const key = (o: typeof q.offer) =>
      JSON.stringify([
        o.optionsV2.map((x) => `${x.id}:${x.meaning}`),
        o.subject?.digest ?? null,
      ]);
    if (key(questionOffer(fresh)) !== key(q.offer)) return "changed";
    const was = q.eventId;
    return {
      was,
      post: async () => ({
        eventId: await send("prose", "m.room.message", {
          ...questionV2Content(fresh),
          [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(fresh),
        }),
      }),
      move: (to) => store.moveQuestionEvent(id, was, to.eventId),
    };
  }
  if (d.decisionKind === "delivery") {
    const f = store.followupEvent(id);
    if (!f?.eventId || f.outcomePostedAt !== null) return "settled";
    const fresh = pending.find(
      (p) => isDeliveryPending(p) && p.gateId === id && p.cardId === d.cardId,
    );
    if (!fresh || !isDeliveryPending(fresh)) return "not-pending";
    if (JSON.stringify(followupOffer(fresh)) !== JSON.stringify(f.offer))
      return "changed";
    const was = f.eventId;
    return {
      was,
      post: async () => ({
        eventId: await send(
          "prose",
          "m.room.message",
          deliveryV2Content(fresh),
        ),
      }),
      move: (to) => store.moveFollowupEvent(id, was, to.eventId),
    };
  }
  const key = { boardId: d.boardId, cardId: d.cardId, waitId: id };
  const a = store.attentionEvent(key);
  if (!a?.eventId || a.outcomePostedAt !== null) return "settled";
  const fresh = pending.find(
    (p) => isAttentionPending(p) && p.waitId === id && p.cardId === d.cardId,
  );
  if (!fresh || !isAttentionPending(fresh)) return "not-pending";
  if (JSON.stringify(attentionOffer(fresh)) !== JSON.stringify(a.options))
    return "changed";
  const was = a.eventId;
  return {
    was,
    post: async () => ({
      eventId: await send("prose", "m.room.message", attentionV2Content(fresh)),
    }),
    move: (to) => store.moveAttentionEvent(key, was, to.eventId),
  };
}

/**
 * Post a decision's card again below and move its record there. A card that cannot move stays the
 * one that counts; a send failure throws, so the join's retry finishes it.
 */
async function moveCardBelow(
  deps: RepostDeps,
  invite: EscalationInvite,
  n: Notice,
  d: DecisionTimeoutDelivery,
  room: BoardRoom,
  reads: Map<string, Promise<unknown[] | null>>,
): Promise<MoveOutcome> {
  const pending = await pendingOf(deps, d.decisionKind, d.boardId, reads);
  if (pending === null) return "not-pending";
  const fresh = rebuild(deps, invite, n, d, room, pending);
  if (typeof fresh === "string") {
    if (fresh === "changed")
      deps.log(
        `board-chat: an escalated card on ${d.boardId} was not moved: the board now offers it differently from what was recorded`,
      );
    return fresh;
  }
  const posted = await fresh.post();
  return settleMove(deps, invite, n, room, fresh.was, posted.eventId, () =>
    fresh.move(posted),
  );
}

/** After the new copy is posted: move the record, and tell whichever copy no longer counts. */
async function settleMove(
  deps: RepostDeps,
  invite: EscalationInvite,
  n: Notice,
  room: BoardRoom,
  was: string,
  copy: string,
  move: () => boolean,
): Promise<MoveOutcome> {
  const say = (part: "moved" | "settled", body: string, to: string) =>
    deps.sender.sendEvent(
      deps.speaker,
      room.roomId,
      "m.room.message",
      repostTxnId(invite, n.noticeId, part),
      { msgtype: "m.text", body, ...reply(to) },
    );
  if (!move()) {
    await say("settled", SETTLED_ABOVE_TEXT, copy);
    return "settled";
  }
  // The record has moved: what follows must not fail the move, or a retry would post it twice.
  await say("moved", MOVED_BELOW_TEXT, was).catch((error: unknown) =>
    deps.log(
      `board-chat: a moved card's old copy on ${n.boardId} could not be told (${describe(error)})`,
    ),
  );
  deps.log(
    `board-chat: an escalated card on ${n.boardId} moved below for an admin who joined`,
  );
  return "moved";
}

/** Post an escalated check set's card again from a fresh read of its checks, and move the record. */
async function moveChecksCardBelow(
  deps: RepostDeps,
  invite: EscalationInvite,
  n: Notice,
  d: DecisionTimeoutDelivery,
  room: BoardRoom,
): Promise<MoveOutcome> {
  const w = deps.store.checksWaiting(d.boardId, d.decisionId);
  if (
    !w?.eventId ||
    w.closedAt !== null ||
    w.roomId !== room.roomId ||
    w.cardId !== d.cardId
  )
    return "settled";
  let checks;
  try {
    const reads = deps.reads;
    const cardChecks = reads?.cardChecks;
    checks = await readWaitingChecks(
      cardChecks
        ? {
            checks: { cardChecks: (b, c) => cardChecks.call(reads, b, c) },
            log: deps.log,
          }
        : { log: deps.log },
      { boardId: d.boardId, cardId: d.cardId, stageKey: w.stageKey },
    );
  } catch (error) {
    deps.log(
      `board-chat: the checks of a card on ${d.boardId} could not be read to move its escalation below (${describe(error)}); the notice is posted alone`,
    );
    return "not-pending";
  }
  if (!checks) return "not-pending";
  const was = w.eventId;
  const copy = await deps.sender.sendEvent(
    deps.speaker,
    room.roomId,
    "m.room.message",
    repostTxnId(invite, n.noticeId, "card"),
    checksWaitingCardContent(w, checks),
  );
  return settleMove(deps, invite, n, room, was, copy, () =>
    deps.store.moveChecksWaiting(d.boardId, d.decisionId, was, copy),
  );
}
