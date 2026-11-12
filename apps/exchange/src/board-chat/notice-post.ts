/**
 * Posting a recorded board-room notice, exactly once, as a reply to the card it concerns.
 *
 * Ported from the AgentPod hub's `services/board-chat/decision-notices.ts` (`handleDecisionTimeout`),
 * `gate-progress.ts`, `gate-hold.ts`, `check-notices.ts` and `checks-waiting.ts`. Every word and
 * every structured half is treaty's:
 *
 * - **reminded**: `decisionNoticeContent`, one `m.text` in reply to the waiting card (a reminder of
 *   overdue checks stands alone: there is no card).
 * - **escalated**: the workspace's owners and admins with a linked Matrix id are invited into the
 *   board's room (`escalationRecipients`: the organization plane's, and only for a board in this
 *   service's own workspace), each once per board (`escalation_invites`), so somebody who leaves is
 *   not invited back; then the notice in reply to the card. Overdue checks escalate with a
 *   `checks.waiting` card listing them as the board reads them now (`cardChecks`), which the notice
 *   replies to and an override must reference.
 * - **approval_recorded**: a quorum gate's progress ("Approved by Ana — 1 of 2…",
 *   `gateProgressBody`) in reply to the gate's prose, then `dev.agentpod.gate.progress.v2`; the
 *   board's count is recorded on the gate first, never walked back.
 * - **released**, **pulled_back**: `releasedBody` / `pulledBackBody` in reply to the gate, then the
 *   structured half (`dev.agentpod.decision.released.v2`, `….pulled_back.v2`).
 * - **check_failed**, **check_overridden**: the line in the board's room, in reply to the open
 *   checks.waiting card for that card and stage when there is one, else standalone; then the
 *   structured half. A failure that sent the card back closes that checks.waiting card.
 *
 * Who did it is named by the plane's label for the principal, never an id; a person who cannot be
 * named is left out of the sentence.
 *
 * The order is a card's (`card-post.ts`): fail closed on encryption (`room-sender.ts`); everything
 * that must be read (the admins, a card's checks) read before anything is claimed, so a plane or a
 * board that cannot be read leaves the notice to be tried again; the claim, with the room and the
 * card it replies to; the sends, each under a transaction id derived from the notice, so a retry is
 * the same message. A failed send keeps its claim: boot, a join in the room and the notice retry
 * (every `SUPEREXCHANGE_SWEEP_SECONDS`) send it again under the same ids. (The hub gives the claim
 * back so the board's push retry posts it; nothing retries a relay delivery here.)
 */
import {
  CHECK_FAILED_TYPE,
  CHECK_OVERRIDDEN_TYPE,
  DECISION_PULLED_BACK_TYPE,
  DECISION_RELEASED_TYPE,
  GATE_PROGRESS_TYPE,
  approvalV2,
  approvalsCounted,
  checkFailedBody,
  checkFailedContent,
  checkOverriddenBody,
  checkOverriddenContent,
  checksV2,
  checksWaitingContent,
  decisionNoticeContent,
  gateProgressBody,
  gateProgressContent,
  pulledBackBody,
  pulledBackContent,
  quorumV2,
  releasedBody,
  releasedContent,
  type CheckFailedDelivery,
  type CheckOverriddenDelivery,
  type CheckV2,
  type DecisionPulledBackDelivery,
  type DecisionReleasedDelivery,
  type DecisionTimeoutDelivery,
  type GateApprovalRecordedDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { Board, BoardRoom, Notice, Store } from "../store/index.ts";
import {
  AccountsError,
  claimOf,
  type Accounts,
  type ServiceTokens,
} from "./accounts.ts";
import { NOTICE_TYPES, unsayable, type Unsayable } from "./notices.ts";
import type { RoomRefusal, RoomSender } from "./room-sender.ts";
import {
  NAMESPACE_USER_PREFIX,
  describe as describeClientError,
} from "./rooms.ts";
import {
  SuperpipelineError,
  type SuperpipelineReads,
} from "./superpipeline.ts";

/** The transaction id a notice's event is sent under: the same on every try. */
export function noticeTxnId(noticeId: string, part: "prose" | "card"): string {
  return `superexchange.notice.${noticeId.slice(0, 32)}.${part}`;
}

/** The transaction id a check set's checks.waiting card is first sent under. */
export function checksWaitingTxnId(boardId: string, arrivalId: string): string {
  const key = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([boardId, arrivalId]))
    .digest("hex")
    .slice(0, 32);
  return `superexchange.checks.${key}.card`;
}

const reply = (eventId: string) => ({
  "m.relates_to": { "m.in_reply_to": { event_id: eventId } },
});

export type NoticePostOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "refused"; reason: RoomRefusal }
  | {
      status: "skipped";
      reason: "unknown" | "dropped" | "board not opted in" | "board disabled";
    }
  | { status: "dropped"; reason: Unsayable | "not a notice" }
  | { status: "failed"; step: "read" | "send" };

/** The board's read of a card's checks, as an escalation's card lists them. */
export type ChecksRead = Pick<SuperpipelineReads, "cardChecks">;

export interface NoticePostDeps {
  store: Pick<
    Store,
    | "getBoard"
    | "boardRoom"
    | "boardRoomByRoomId"
    | "notice"
    | "claimNotice"
    | "recordNoticeProse"
    | "recordNoticePosted"
    | "dropNotice"
    | "knownCardTitle"
    | "gateEvent"
    | "gateDelivery"
    | "recordGateQuorum"
    | "questionEvent"
    | "questionDelivery"
    | "followupEvent"
    | "attentionEvent"
    | "checksWaiting"
    | "claimChecksWaiting"
    | "recordChecksWaitingPosted"
    | "openChecksWaiting"
    | "closeChecksWaiting"
    | "claimEscalationInvite"
    | "forgetEscalationInvite"
    | "membershipOf"
    | "recordMembership"
  >;
  sender: RoomSender;
  speaker: string;
  /** Null when the room may be spoken in; else the refusal, logged once per board by the caller. */
  refuse(
    boardId: string,
    room: Pick<BoardRoom, "encrypted">,
  ): RoomRefusal | null;
  /** Invite somebody into a room, as the speaker. Absent: an escalation invites nobody. */
  invite?(roomId: string, userId: string): Promise<void>;
  /** Whom an escalation on this board invites (`escalationRecipients`). Absent: nobody. */
  recipients?(board: Board): Promise<string[]>;
  /** The board's read of a card's checks. Absent: overdue checks escalate with the notice alone. */
  checks?: ChecksRead;
  /** How a sentence names a principal; null when it cannot. */
  labelFor?(principalId: string): Promise<string | null>;
  log: (line: string) => void;
}

/** How a log names a notice: its kind and board, never its content. */
function noticeAt(n: Pick<Notice, "notice" | "boardId">): string {
  const what = Object.values(NOTICE_TYPES).find(
    (t) => t.notice === n.notice,
  )?.what;
  return `${what ?? "notice"} on ${n.boardId}`;
}

/** Post one recorded notice. Run only in board chat's queue. */
export async function postNotice(
  deps: NoticePostDeps,
  noticeId: string,
): Promise<NoticePostOutcome> {
  const { store, log } = deps;
  const n = store.notice(noticeId);
  if (n === null) return { status: "skipped", reason: "unknown" };
  if (n.postedAt !== null) return { status: "already" };
  if (n.droppedAt !== null) return { status: "skipped", reason: "dropped" };
  const board = store.getBoard(n.boardId);
  if (board === null)
    return { status: "skipped", reason: "board not opted in" };
  if (!board.enabled) return { status: "skipped", reason: "board disabled" };
  const at = noticeAt(n);
  const drop = (reason: Unsayable | "not a notice"): NoticePostOutcome => {
    if (store.dropNotice(noticeId))
      log(`board-chat: a ${at} has nothing to reply to (${reason}); not said`);
    return { status: "dropped", reason };
  };
  const spec = Object.values(NOTICE_TYPES).find((t) => t.notice === n.notice);
  if (!spec || !spec.is(n.body)) return drop("not a notice");

  const room = n.roomId
    ? store.boardRoomByRoomId(n.roomId)
    : store.boardRoom(n.boardId);
  if (room === null) return drop("no room");
  const refused = deps.refuse(n.boardId, room);
  if (refused) return { status: "refused", reason: refused };

  if (n.claimedAt === null) {
    // The card may have been settled since the notice was recorded.
    const why = unsayable(store, n);
    if (why !== null) return drop(why);
    let replyTo: string | null;
    try {
      replyTo = await prepare(deps, n, board, room);
    } catch (error) {
      log(
        `board-chat: a ${at} waits: what it needs could not be read (${describe(error)}); it is tried again`,
      );
      return { status: "failed", step: "read" };
    }
    store.claimNotice(noticeId, room.roomId, replyTo);
  }

  const claim = store.notice(noticeId);
  if (claim === null || claim.roomId === null)
    return { status: "failed", step: "send" };
  try {
    const eventId = await send(deps, claim);
    store.recordNoticePosted(noticeId);
    log(`board-chat: a ${at} posted`);
    return { status: "posted", roomId: claim.roomId, eventId };
  } catch (error) {
    // The claim stays: the next boot, join or retry sends it under the same ids.
    log(
      `board-chat: a ${at} not posted (${describe(error)}); it is tried again`,
    );
    return { status: "failed", step: "send" };
  }
}

/**
 * Everything before the claim: the card the notice replies to, and for an escalation the invites
 * and, for overdue checks, the checks.waiting card. Throws when the plane or the board cannot be
 * read, so nothing is claimed.
 */
async function prepare(
  deps: NoticePostDeps,
  n: Notice,
  board: Board,
  room: BoardRoom,
): Promise<string | null> {
  const { store } = deps;
  const b = n.body as Record<string, unknown>;
  switch (n.notice) {
    case "reminded":
    case "escalated": {
      const d = n.body as DecisionTimeoutDelivery;
      const checks = d.decisionKind === "checks";
      let replyTo: string | null = null;
      if (!checks) {
        const card = cardFor(store, d);
        replyTo = card;
      }
      if (n.notice === "escalated") {
        // Read before anything is claimed: a plane that cannot be read is tried again.
        const admins = deps.recipients ? await deps.recipients(board) : [];
        const waiting = checks ? await readWaitingChecks(deps, d) : null;
        await inviteAdmins(deps, admins, room);
        if (waiting)
          replyTo = await postChecksWaitingCard(deps, d, room, waiting);
      }
      return replyTo;
    }
    case "approval_recorded": {
      const d = n.body as GateApprovalRecordedDelivery;
      const quorum = quorumV2(d.quorum);
      // The board's count, recorded first: an approving answer is judged against it.
      if (quorum) store.recordGateQuorum(d.gateId, quorum);
      return gateReplyTarget(store, d.gateId);
    }
    case "released":
    case "pulled_back":
      return gateReplyTarget(store, String(b.gateId));
    case "check_failed":
    case "check_overridden":
      return (
        store.openChecksWaiting(
          n.boardId,
          n.cardId,
          String(b.stageKey),
          room.roomId,
        )?.eventId ?? null
      );
  }
}

/** The reminded or escalated card's message, checked by `unsayable` before. */
function cardFor(
  store: NoticePostDeps["store"],
  d: DecisionTimeoutDelivery,
): string | null {
  if (d.decisionKind === "gate") return gateReplyTarget(store, d.decisionId);
  if (d.decisionKind === "question")
    return store.questionEvent(d.decisionId)?.eventId ?? null;
  if (d.decisionKind === "delivery")
    return store.followupEvent(d.decisionId)?.eventId ?? null;
  return (
    store.attentionEvent({
      boardId: d.boardId,
      cardId: d.cardId,
      waitId: d.decisionId,
    })?.eventId ?? null
  );
}

/** A gate's prose, which every reply to it references, else its card event. */
function gateReplyTarget(
  store: Pick<Store, "gateEvent">,
  gateId: string,
): string | null {
  const g = store.gateEvent(gateId);
  return g?.proseEventId ?? g?.cardEventId ?? null;
}

/**
 * Invite each recipient not yet invited to this board, recorded first so a second escalation does
 * not invite again. Somebody already joined or invited counts as invited. An invite the homeserver
 * refuses is forgotten, so the next escalation tries again.
 */
async function inviteAdmins(
  deps: NoticePostDeps,
  admins: string[],
  room: BoardRoom,
): Promise<number> {
  const { store, log } = deps;
  if (!deps.invite) {
    if (admins.length > 0)
      log(
        `board-chat: an escalation on ${room.boardId} could not invite anyone: no invite is wired`,
      );
    return 0;
  }
  let invited = 0;
  for (const userId of admins) {
    if (userId === deps.speaker || userId.startsWith(NAMESPACE_USER_PREFIX))
      continue;
    if (!store.claimEscalationInvite(room.boardId, userId, room.roomId))
      continue;
    const membership = store.membershipOf(room.roomId, userId);
    // Already a member: the record stands, so leaving later is not answered with another invite.
    if (membership === "join" || membership === "invite") continue;
    try {
      await deps.invite(room.roomId, userId);
      store.recordMembership(room.roomId, userId, "invite");
      invited++;
    } catch (error) {
      store.forgetEscalationInvite(room.boardId, userId);
      log(
        `board-chat: an escalation on ${room.boardId} could not invite a workspace admin (${describe(error)})`,
      );
    }
  }
  if (admins.length > 0)
    log(
      `board-chat: an escalation on ${room.boardId} invited ${invited} of ${admins.length} workspace admin(s)`,
    );
  return invited;
}

/**
 * The checks an escalation's card lists, from the board's read now, or null when there is nothing
 * to offer an override on: no read wired, the card at no stage with checks, its checks over (`status`
 * not `open`) or at another stage than the one that timed out, a list treaty will not carry, or a
 * board that refuses the read (4xx: this service is not admitted there). A board that cannot be
 * reached or fails (5xx) throws, so the notice is tried again before anything is claimed.
 */
export async function readWaitingChecks(
  deps: Pick<NoticePostDeps, "checks" | "log">,
  d: Pick<DecisionTimeoutDelivery, "boardId" | "cardId" | "stageKey">,
): Promise<CheckV2[] | null> {
  if (!deps.checks) return null;
  let read: Awaited<ReturnType<ChecksRead["cardChecks"]>>;
  try {
    read = await deps.checks.cardChecks(d.boardId, d.cardId);
  } catch (error) {
    if (
      error instanceof SuperpipelineError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      deps.log(
        `board-chat: the checks of a card on ${d.boardId} could not be read (${error.message}); the escalation is said alone`,
      );
      return null;
    }
    throw error;
  }
  if (!read || read.status !== "open" || read.stageKey !== d.stageKey)
    return null;
  return checksV2(read.checks);
}

/** The checks.waiting card's content: treaty's, from what was recorded and the checks read now. */
export function checksWaitingCardContent(
  w: {
    boardId: string;
    cardId: string;
    cardTitle: string;
    stageKey: string;
    stageName?: string | null;
  },
  checks: CheckV2[],
): Record<string, unknown> {
  return checksWaitingContent({
    boardId: w.boardId,
    cardId: w.cardId,
    cardTitle: w.cardTitle,
    stageKey: w.stageKey,
    stageName: w.stageName ?? null,
    checks,
  });
}

/**
 * Post the checks.waiting card for an escalated check set, once, and answer its event, or the
 * event of the one already posted for it. Claimed before it is sent, under one transaction id, so
 * a retry is the same card. Throws on a send failure; the claim stays.
 */
async function postChecksWaitingCard(
  deps: NoticePostDeps,
  d: DecisionTimeoutDelivery,
  room: BoardRoom,
  checks: CheckV2[],
): Promise<string | null> {
  const { store } = deps;
  store.claimChecksWaiting({
    boardId: d.boardId,
    arrivalId: d.decisionId,
    cardId: d.cardId,
    cardTitle: d.cardTitle,
    stageKey: d.stageKey,
    stageName: typeof d.stageName === "string" ? d.stageName : null,
    roomId: room.roomId,
  });
  const w = store.checksWaiting(d.boardId, d.decisionId);
  if (w === null || w.roomId !== room.roomId || w.cardId !== d.cardId)
    return null;
  if (w.postedAt !== null) return w.eventId;
  const eventId = await deps.sender.sendEvent(
    deps.speaker,
    room.roomId,
    "m.room.message",
    checksWaitingTxnId(d.boardId, d.decisionId),
    checksWaitingCardContent(w, checks),
  );
  store.recordChecksWaitingPosted(d.boardId, d.decisionId, eventId);
  return eventId;
}

/** The plane's label for a principal, or null: the sentence leaves them out. */
async function nameOf(
  deps: Pick<NoticePostDeps, "labelFor">,
  principalId: string,
): Promise<string | null> {
  try {
    return (await deps.labelFor?.(principalId)) ?? null;
  } catch {
    return null;
  }
}

/** The prose and, for most notices, its structured half; under the notice's transaction ids. */
async function send(deps: NoticePostDeps, n: Notice): Promise<string> {
  const { store, sender, speaker } = deps;
  const roomId = n.roomId as string;
  const said = await compose(deps, n);
  let proseEventId = n.proseEventId;
  if (proseEventId === null) {
    proseEventId = await sender.sendEvent(
      speaker,
      roomId,
      "m.room.message",
      noticeTxnId(n.noticeId, "prose"),
      said.prose,
    );
    store.recordNoticeProse(n.noticeId, proseEventId);
  }
  if (said.structured) {
    await sender.sendEvent(
      speaker,
      roomId,
      said.structured.type,
      noticeTxnId(n.noticeId, "card"),
      said.structured.content,
    );
  }
  if (said.closesWaiting) said.closesWaiting();
  return proseEventId;
}

interface Said {
  prose: Record<string, unknown>;
  structured?: { type: string; content: Record<string, unknown> };
  closesWaiting?: () => void;
}

async function compose(deps: NoticePostDeps, n: Notice): Promise<Said> {
  const { store } = deps;
  const replyTo = n.replyTo;
  const inReply = replyTo ? reply(replyTo) : {};
  const text = (body: string) => ({ msgtype: "m.text", body, ...inReply });
  switch (n.notice) {
    case "reminded":
    case "escalated":
      return {
        prose: decisionNoticeContent(
          n.body as DecisionTimeoutDelivery,
          replyTo,
        ),
      };
    case "approval_recorded": {
      const d = n.body as GateApprovalRecordedDelivery;
      const approval = approvalV2(d.approval);
      const quorum = quorumV2(d.quorum);
      if (!approval || !quorum) throw new Error("malformed");
      const gate = store.gateEvent(d.gateId);
      const who = await nameOf(deps, approval.principal_id);
      const variantLabel = approval.variant_id
        ? (gate?.offer?.variants?.find((v) => v.id === approval.variant_id)
            ?.label ?? null)
        : null;
      return {
        prose: text(
          gateProgressBody({
            who,
            variantLabel,
            count: approvalsCounted(quorum, approval),
            required: quorum.required,
          }),
        ),
        structured: {
          type: GATE_PROGRESS_TYPE,
          content: gateProgressContent({
            gateId: d.gateId,
            boardId: d.boardId,
            cardId: d.cardId,
            approval,
            quorum,
            approvedBy: who,
            variantLabel,
            gateEventId: gateEventOf(store, d.gateId),
          }),
        },
      };
    }
    case "released": {
      const d = n.body as DecisionReleasedDelivery;
      return {
        prose: text(releasedBody(d)),
        structured: {
          type: DECISION_RELEASED_TYPE,
          content: releasedContent(d, gateEventOf(store, d.gateId)),
        },
      };
    }
    case "pulled_back": {
      const d = n.body as DecisionPulledBackDelivery;
      const who = await nameOf(deps, d.pulledBackBy);
      return {
        prose: text(pulledBackBody({ who, comment: d.comment })),
        structured: {
          type: DECISION_PULLED_BACK_TYPE,
          content: pulledBackContent(d, who, gateEventOf(store, d.gateId)),
        },
      };
    }
    case "check_failed":
    case "check_overridden": {
      const d = n.body as CheckFailedDelivery | CheckOverriddenDelivery;
      const waiting = replyTo
        ? store.openChecksWaiting(
            d.boardId,
            d.cardId,
            d.stageKey,
            n.roomId as string,
          )
        : null;
      const pushed = d.cardTitle.trim();
      const title =
        pushed !== ""
          ? pushed
          : (waiting?.cardTitle ?? store.knownCardTitle(d.boardId, d.cardId));
      if (d.event === "check.failed") {
        return {
          prose: text(checkFailedBody(d, title)),
          structured: {
            type: CHECK_FAILED_TYPE,
            content: checkFailedContent(d, title, replyTo ?? undefined),
          },
          // The card went back: these checks are over, and the card that stood for them closes.
          ...(d.returnedTo !== null && waiting
            ? {
                closesWaiting: () =>
                  store.closeChecksWaiting(d.boardId, waiting.arrivalId),
              }
            : {}),
        };
      }
      const who = await nameOf(deps, d.by);
      return {
        prose: text(checkOverriddenBody(d, who, title)),
        structured: {
          type: CHECK_OVERRIDDEN_TYPE,
          content: checkOverriddenContent(d, who, title, replyTo ?? undefined),
        },
      };
    }
  }
}

/** The gate's own card event, which a structured half references; its prose when it has none. */
function gateEventOf(store: Pick<Store, "gateEvent">, gateId: string): string {
  const g = store.gateEvent(gateId);
  return g?.cardEventId ?? g?.proseEventId ?? "";
}

/**
 * Whom an escalation on a board invites: the workspace's owners and admins with a linked Matrix id
 * (`Accounts.workspaceAdmins`). The plane answers for this service's own workspace (its token's
 * `org`), so a board in any other workspace escalates to nobody, logged once per board (the hub's
 * "one tenant or nobody"). Throws when the token or the plane cannot be had, so the escalation is
 * tried again rather than said to nobody.
 */
export function createEscalationRecipients(deps: {
  tokens: Pick<ServiceTokens, "get">;
  accounts: Pick<Accounts, "workspaceAdmins">;
  log: (line: string) => void;
}): (board: Board) => Promise<string[]> {
  const warned = new Set<string>();
  return async (board) => {
    const org = claimOf(await deps.tokens.get(), "org");
    if (typeof org !== "string" || org === "" || org !== board.orgId) {
      if (!warned.has(board.boardId)) {
        warned.add(board.boardId);
        deps.log(
          `board-chat: an escalation on ${board.boardId} invites nobody: the board is not in this service's workspace`,
        );
      }
      return [];
    }
    return deps.accounts.workspaceAdmins();
  };
}

/** An error as a log may carry it: status and code only, never a URL, a token or a body. */
function describe(error: unknown): string {
  if (error instanceof SuperpipelineError || error instanceof AccountsError)
    return error.message;
  return describeClientError(error);
}
