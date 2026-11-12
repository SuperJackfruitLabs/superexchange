/**
 * The shapes the store reads and writes, the `Store` its callers use, and its error.
 */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** A board an operator has pointed at this service. */
export interface Board {
  boardId: string;
  spTenantId: string;
  orgId: string;
  /** Matrix user ids invited to the board's room. */
  invitees: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardInput {
  boardId: string;
  spTenantId: string;
  orgId: string;
  invitees: string[];
}

/** A board's room, as recorded when it was made. */
export interface BoardRoom {
  boardId: string;
  roomId: string;
  /** The alias's localpart. */
  alias: string;
  /**
   * Whether the room is end-to-end encrypted. Fixed when the room is recorded: Matrix has no way
   * to turn encryption off, and a plaintext room is never turned on here.
   */
  encrypted: boolean;
  createdAt: string;
}

/** An encrypted event waiting for the key that opens it, exactly as it was delivered. */
export interface PendingDecrypt {
  eventId: string;
  roomId: string;
  /** The event as the homeserver delivered it, still encrypted. */
  event: Record<string, unknown>;
  firstSeenAt: string;
}

/** One option a gate offered when it was posted. */
export interface GateOfferOption {
  id: string;
  label: string;
  /** What choosing it does: `approve`, `reject`, `revise`, … */
  meaning: string;
  needs_comment: boolean;
}

/** One variant a choice gate offered when it was posted. */
export interface GateOfferVariant {
  id: string;
  label: string;
  subject_id: string;
  digest: string;
  preview_complete: boolean;
  expires_at: string | null;
}

/**
 * What a gate offered when it was posted: an answer is checked against this, never against a
 * fixed list. Recorded with the claim, before anything is sent.
 */
export interface GateOffer {
  options: GateOfferOption[];
  /** The subject a subject-bound gate approves; null when it is bound to none. */
  subjectId: string | null;
  subjectDigest: string | null;
  /** Whether the subject's preview was shown in full; null when there is no subject. */
  subjectPreviewComplete: boolean | null;
  /** A choice gate's variants; null when it is not a choice. */
  variants: GateOfferVariant[] | null;
  /** A quorum gate's quorum as posted (treaty's `quorumV2`), or null when one approval passes it. */
  quorum: unknown;
}

/**
 * A gate's claim on its room. A row with no `postedAt` is claimed and not yet (fully) posted:
 * the prose may already have landed (`proseEventId`), the card not.
 */
export interface GateEvent {
  gateId: string;
  boardId: string;
  roomId: string;
  cardEventId: string | null;
  proseEventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  /** What the gate offered; null for a gate claimed before offers were recorded. */
  offer: GateOffer | null;
  /** Set while, or once, a person's answer is being carried to the board. */
  outcomeClaimedAt: string | null;
  /** Set once the receipt is claimed for posting: a gate gets one receipt. */
  outcomePostedAt: string | null;
  /** Set when the sweep claimed the receipt for a gate the board says was decided elsewhere. */
  settledAt: string | null;
  /** The decision the board gave for it then. */
  settledDecision: string | null;
}

/** One option of a question as it was posted, in question.v2's shape (treaty's `QuestionOptionV2`). */
export interface QuestionOfferOption {
  id: string;
  label: string;
  meaning: string;
  needs_comment: boolean;
  input?: {
    kind: "text" | "url";
    label?: string;
    required: boolean;
    max_length: number;
  };
  scope?: string;
  requires?: string;
}

/** The subject a question is bound to, as it was posted. */
export interface QuestionOfferSubject {
  id: string;
  digest: string;
  /** False refuses an approving answer: the card could not show all of it. */
  previewComplete: boolean;
  /** ISO; null when the subject named no expiry that could be read. */
  expiresAt: string | null;
}

/**
 * What a question offered when it was posted. Recorded with the claim, before anything is sent:
 * a structured answer is judged against `optionsV2`, a typed reply matched against `options`.
 */
export interface QuestionOffer {
  /** `{id, label}` in the order the prose numbers them: what a typed reply is matched against. */
  options: Array<{ id: string; label: string }>;
  /** What question.v2 carried. */
  optionsV2: QuestionOfferOption[];
  /** A question with no options is answered by typing, at most this many characters; else null. */
  freeTextMaxLength: number | null;
  subject: QuestionOfferSubject | null;
  /** A SuperToolkit approval request: answered by a person only, never allowed unbound. */
  approvalRequest: boolean;
}

/** A question's claim on its room. No `eventId` means claimed and not yet posted. */
export interface QuestionEvent {
  elicitationId: string;
  boardId: string;
  roomId: string;
  /** The prose message: the one event an answer may reference. */
  eventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  offer: QuestionOffer;
  /** Set once the receipt is claimed: a question gets one. */
  outcomePostedAt: string | null;
  /** Set when the sweep claimed the receipt for a question the board no longer waits on. */
  settledAt: string | null;
}

/**
 * One option of a follow-up or a waiting card as it was posted (treaty's `DeliveryOptionV2`,
 * `AttentionOptionV2`), kept to what an answer is judged against.
 */
export interface CardOfferOption {
  id: string;
  label: string;
  input?: { kind: "text" | "url"; required: boolean; max_length: number };
}

/** What a delivery follow-up offered when it was posted. */
export interface FollowupOffer {
  options: CardOfferOption[];
  /** Whether its subject's preview reached the room in full; anything but true refuses automatic. */
  subjectPreviewComplete: boolean | null;
}

/** A follow-up's claim on its room, keyed by the gate it follows. No `eventId`: not yet posted. */
export interface FollowupEvent {
  gateId: string;
  boardId: string;
  cardId: string;
  roomId: string;
  /** The follow-up's message: the one event an answer may reference. */
  eventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  offer: FollowupOffer;
  /** Set once the receipt is claimed: a follow-up gets one. */
  outcomePostedAt: string | null;
  /** Set when the sweep claimed the receipt for a follow-up the board no longer owes. */
  settledAt: string | null;
}

/** A delivered follow-up with no posted event yet. */
export interface UnpostedFollowup {
  gateId: string;
  boardId: string;
  body: unknown;
}

/** Which wait a waiting card is: a card that parks again is a new one. */
export interface WaitKey {
  boardId: string;
  cardId: string;
  waitId: string;
}

/** A waiting card's claim on its room. No `eventId`: not yet posted. */
export interface AttentionEvent extends WaitKey {
  roomId: string;
  /** The card's message: the one event an answer may reference. */
  eventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  /** What it offered when it was posted. */
  options: CardOfferOption[];
  /** Set once the receipt is claimed: a wait gets one. */
  outcomePostedAt: string | null;
  /** Set when the sweep claimed the receipt for a wait that ended elsewhere. */
  settledAt: string | null;
}

/** A delivered waiting card with no posted event yet. */
export interface UnpostedAttention extends WaitKey {
  body: unknown;
}

/** A delivered question with no posted event yet. */
export interface UnpostedQuestion {
  elicitationId: string;
  boardId: string;
  body: unknown;
}

/** A delivered gate with no posted event yet. */
export interface UnpostedGate {
  gateId: string;
  boardId: string;
  body: unknown;
}

/** What a board-room notice says. */
export type NoticeKind =
  | "reminded"
  | "escalated"
  | "approval_recorded"
  | "released"
  | "pulled_back"
  | "check_failed"
  | "check_overridden";

/** A notice to record: its key is what makes a redelivery the same notice. */
export interface NoticeInput {
  noticeId: string;
  notice: NoticeKind;
  boardId: string;
  cardId: string;
  /** A reminder's or an escalation's decision; null for the other notices. */
  decisionKind: string | null;
  decisionId: string | null;
  body: unknown;
}

/** A recorded notice and how far it got. */
export interface Notice extends NoticeInput {
  receivedAt: string;
  /** The room it is said in, from its claim; null while unclaimed. */
  roomId: string | null;
  /** The card it replies to, from its claim; null when it stands alone. */
  replyTo: string | null;
  claimedAt: string | null;
  /** The prose line's event, once it landed. */
  proseEventId: string | null;
  postedAt: string | null;
  /** Set when it had nothing true to say: never posted after. */
  droppedAt: string | null;
  /** An escalation: when it was last posted again for somebody who joined. */
  repostedAt: string | null;
  /** An escalation: when its card was last moved below for somebody who joined. */
  cardMovedAt: string | null;
}

/** Somebody an escalation invited into a board's room. */
export interface EscalationInvite {
  boardId: string;
  userId: string;
  roomId: string;
  invitedAt: string;
  joinedAt: string | null;
  repostedAt: string | null;
  repostAttempts: number;
}

/** The checks.waiting card an escalation of overdue checks posted, keyed by the check set's arrival. */
export interface ChecksWaiting {
  boardId: string;
  arrivalId: string;
  cardId: string;
  cardTitle: string;
  stageKey: string;
  stageName: string | null;
  roomId: string;
  /** The card's current event: what an override must reference. Null until it is posted. */
  eventId: string | null;
  claimedAt: string;
  postedAt: string | null;
  /** Set when its checks are over (the card went back): no notice replies to it after. */
  closedAt: string | null;
}

export interface Store {
  /** The schema version the database is at. */
  schemaVersion(): number;
  /**
   * Record a homeserver transaction id. True the first time, false for a repeat: the caller
   * applies a transaction only when this says it is new.
   */
  claimTransaction(txnId: string): boolean;
  /** Create or replace a board's settings, and enable it. */
  upsertBoard(input: BoardInput): Board;
  /** Disable a board; null when it was never opted in. */
  disableBoard(boardId: string): Board | null;
  getBoard(boardId: string): Board | null;
  listBoards(): Board[];
  /** Record a delivered gate. True when new, false when this gate id was already recorded. */
  recordGateDelivery(gateId: string, boardId: string, body: unknown): boolean;
  /** The recorded body of a gate, and when it was settled (null while it is not), or null. */
  gateDelivery(
    gateId: string,
  ): { boardId: string; body: unknown; settledAt: string | null } | null;
  /**
   * Delivered gates not yet posted and not settled, oldest first: never claimed, or claimed and
   * unfinished. Only `boardId`'s when it is given.
   */
  unpostedGates(boardId?: string): UnpostedGate[];
  /**
   * Mark a delivered gate settled: the board says it was decided, so it is never posted after
   * this. True when this call settled it.
   */
  settleGateDelivery(gateId: string): boolean;

  /**
   * Record a board's room, and whether it is encrypted. The first record wins: returns the room
   * on record afterwards, which is this one unless another was recorded first.
   */
  recordBoardRoom(
    boardId: string,
    roomId: string,
    alias: string,
    encrypted: boolean,
  ): BoardRoom;
  boardRoom(boardId: string): BoardRoom | null;
  /** The board room a Matrix room is, or null. */
  boardRoomByRoomId(roomId: string): BoardRoom | null;

  /** Record a user's membership of a room (`join`, `invite`, `leave`, `ban`, `knock`). */
  recordMembership(roomId: string, userId: string, membership: string): void;
  /** The users recorded with a membership of `membership` in a room. */
  membersOf(roomId: string, membership: string): string[];
  /** A user's recorded membership of a room, or null. */
  membershipOf(roomId: string, userId: string): string | null;

  /**
   * Claim a gate's post into a room, recording what it offers. True when this call made the
   * claim; false when the gate was already claimed (posted or not), and the offer is not changed.
   */
  claimGateEvent(
    gateId: string,
    boardId: string,
    roomId: string,
    offer?: GateOffer,
  ): boolean;
  gateEvent(gateId: string): GateEvent | null;
  /** Record the prose message's event id, once it has landed. */
  recordGateProse(gateId: string, proseEventId: string): void;
  /** Record the card's event id, and that the gate is posted. */
  recordGatePosted(gateId: string, cardEventId: string): void;
  /**
   * Claim a gate's outcome before a person's answer is carried to the board. True when this call
   * made the claim; false when another answer holds it, or already acted.
   */
  claimGateOutcome(gateId: string): boolean;
  /** Give an outcome claim back, so the next answer may act: the board did not take this one. */
  releaseGateOutcome(gateId: string): void;
  /** Claim the gate's receipt before it is sent. True once per gate. */
  claimGateReceipt(gateId: string): boolean;
  /**
   * Claim the one "how to link" reply a sender linked to nobody gets in a room on a UTC day
   * (`YYYY-MM-DD`). True once per sender, room and day; earlier days are forgotten.
   */
  claimLinkHint(sender: string, roomId: string, day: string): boolean;
  /**
   * The sweep's claim on a posted gate's receipt, for a gate the board says was decided
   * elsewhere: true once per gate, and false once any receipt is claimed (the answer path's
   * included) or the gate is not posted. It takes the outcome too, so a later answer in chat is
   * told it was already decided. Called only between answers (board chat's queue), so an
   * outcome claim still held then is one the board refused as not pending, and is settled here.
   */
  settleGateEvent(gateId: string, decision: string): boolean;
  /** A board's posted gates whose receipt is not claimed, oldest first. */
  postedGatesAwaitingOutcome(boardId: string): GateEvent[];
  /**
   * Give back every outcome claim whose receipt was never claimed: at boot, nothing is carrying
   * an answer, so such a claim was left by a run that stopped mid-answer. Answers how many.
   */
  releaseUnfinishedOutcomes(): number;

  /** Record a delivered question. True when new, false when this id was already recorded. */
  recordQuestionDelivery(
    elicitationId: string,
    boardId: string,
    body: unknown,
  ): boolean;
  /** The recorded body of a question, and when it was settled (null while it is not), or null. */
  questionDelivery(
    elicitationId: string,
  ): { boardId: string; body: unknown; settledAt: string | null } | null;
  /** Delivered questions not yet posted and not settled, oldest first; only `boardId`'s if given. */
  unpostedQuestions(boardId?: string): UnpostedQuestion[];
  /** Mark a delivered question settled: never posted after this. True when this call did. */
  settleQuestionDelivery(elicitationId: string): boolean;
  /**
   * Claim a question's post into a room, recording what it offers. True when this call made the
   * claim; false when it was already claimed, and the offer is not changed.
   */
  claimQuestionEvent(
    elicitationId: string,
    boardId: string,
    roomId: string,
    offer: QuestionOffer,
  ): boolean;
  questionEvent(elicitationId: string): QuestionEvent | null;
  /** Record the question's message, and that it is posted. */
  recordQuestionPosted(elicitationId: string, eventId: string): void;
  /** A room's posted questions whose receipt is not claimed, newest first. */
  openQuestionsInRoom(roomId: string): QuestionEvent[];
  /** Claim a posted question's receipt before it is sent. True once per question. */
  claimQuestionReceipt(elicitationId: string): boolean;
  /**
   * The sweep's claim on a posted question's receipt, for one the board no longer waits on: true
   * once, false once any receipt is claimed or the question is not posted.
   */
  settleQuestionEvent(elicitationId: string): boolean;
  /** A board's posted questions whose receipt is not claimed, oldest first. */
  postedQuestionsAwaitingOutcome(boardId: string): QuestionEvent[];

  /** Record a delivered follow-up. True when new, false when this gate's was already recorded. */
  recordFollowupDelivery(
    gateId: string,
    boardId: string,
    body: unknown,
  ): boolean;
  /** The recorded body of a follow-up, and when it was settled (null while it is not), or null. */
  followupDelivery(
    gateId: string,
  ): { boardId: string; body: unknown; settledAt: string | null } | null;
  /** Delivered follow-ups not yet posted and not settled, oldest first; only `boardId`'s if given. */
  unpostedFollowups(boardId?: string): UnpostedFollowup[];
  /** Mark a delivered follow-up settled: never posted after this. True when this call did. */
  settleFollowupDelivery(gateId: string): boolean;
  /** Claim a follow-up's post into a room, recording what it offers. True when this call did. */
  claimFollowupEvent(
    gateId: string,
    boardId: string,
    cardId: string,
    roomId: string,
    offer: FollowupOffer,
  ): boolean;
  followupEvent(gateId: string): FollowupEvent | null;
  /** Record the follow-up's message, and that it is posted. */
  recordFollowupPosted(gateId: string, eventId: string): void;
  /** Claim a posted follow-up's receipt before it is sent. True once per follow-up. */
  claimFollowupReceipt(gateId: string): boolean;
  /** The sweep's claim on a posted follow-up's receipt: true once, false once any is claimed. */
  settleFollowupEvent(gateId: string): boolean;
  /** A board's posted follow-ups whose receipt is not claimed, oldest first. */
  postedFollowupsAwaitingOutcome(boardId: string): FollowupEvent[];

  /** Record a delivered waiting card. True when new, false when this wait was already recorded. */
  recordAttentionDelivery(key: WaitKey, body: unknown): boolean;
  /** The recorded body of a waiting card, and when it was settled, or null. */
  attentionDelivery(
    key: WaitKey,
  ): { body: unknown; settledAt: string | null } | null;
  /** Delivered waiting cards not yet posted and not settled, oldest first; only `boardId`'s if given. */
  unpostedAttention(boardId?: string): UnpostedAttention[];
  /** Mark a delivered waiting card settled: never posted after this. True when this call did. */
  settleAttentionDelivery(key: WaitKey): boolean;
  /** Claim a waiting card's post into a room, recording what it offers. True when this call did. */
  claimAttentionEvent(
    key: WaitKey,
    roomId: string,
    options: CardOfferOption[],
  ): boolean;
  attentionEvent(key: WaitKey): AttentionEvent | null;
  /** Record the waiting card's message, and that it is posted. */
  recordAttentionPosted(key: WaitKey, eventId: string): void;
  /** Claim a posted waiting card's receipt before it is sent. True once per wait. */
  claimAttentionReceipt(key: WaitKey): boolean;
  /** The sweep's claim on a posted waiting card's receipt: true once, false once any is claimed. */
  settleAttentionEvent(key: WaitKey): boolean;
  /** A board's posted waiting cards whose receipt is not claimed, oldest first. */
  postedAttentionAwaitingOutcome(boardId: string): AttentionEvent[];

  /**
   * Point a posted gate at a new copy of its card, only while it still points at the old one and
   * has no receipt. True when it moved.
   */
  moveGateEvent(
    gateId: string,
    was: { proseEventId: string | null; cardEventId: string | null },
    to: { proseEventId: string; cardEventId: string },
  ): boolean;
  /**
   * Record a quorum gate's count as the board gives it, only while the gate has no receipt and
   * the count does not go down. True when it was recorded.
   */
  recordGateQuorum(gateId: string, quorum: { approvals: unknown[] }): boolean;
  /** Point a posted question at a new copy, as `moveGateEvent`. */
  moveQuestionEvent(elicitationId: string, was: string, to: string): boolean;
  /** Point a posted follow-up at a new copy, as `moveGateEvent`. */
  moveFollowupEvent(gateId: string, was: string, to: string): boolean;
  /** Point a posted waiting card at a new copy, as `moveGateEvent`. */
  moveAttentionEvent(key: WaitKey, was: string, to: string): boolean;

  /** Record a notice. True when new, false when this key was already recorded. */
  recordNotice(input: NoticeInput): boolean;
  notice(noticeId: string): Notice | null;
  /** Notices neither posted nor dropped, oldest first; only `boardId`'s when it is given. */
  unpostedNotices(boardId?: string): Notice[];
  /** Claim a notice's post: the room, and the card it replies to. True once. */
  claimNotice(
    noticeId: string,
    roomId: string,
    replyTo: string | null,
  ): boolean;
  /** Record a claimed notice's prose line, once it landed. */
  recordNoticeProse(noticeId: string, eventId: string): void;
  /** Record that a claimed notice is posted. */
  recordNoticePosted(noticeId: string): void;
  /** Drop an unclaimed notice: it is never posted. True when this call dropped it. */
  dropNotice(noticeId: string): boolean;
  /** A board's posted escalations, oldest first. */
  postedEscalations(boardId: string): Notice[];
  /**
   * Claim an escalation's re-post for a join at `joinedAt`: true when it was not re-posted since.
   * A failed re-post gives it back with `releaseNoticeRepost`.
   */
  claimNoticeRepost(noticeId: string, joinedAt: string): boolean;
  /** Give a re-post claim back: the re-post failed, and the next pass tries it again. */
  releaseNoticeRepost(noticeId: string, previous: string | null): void;
  /** Record that an escalation's card was moved below. */
  recordNoticeCardMoved(noticeId: string): void;
  /** The newest non-empty card title a reminder or escalation of this card recorded, or null. */
  knownCardTitle(boardId: string, cardId: string): string | null;

  /** Record that an escalation invites somebody to a board. True when this call recorded it. */
  claimEscalationInvite(
    boardId: string,
    userId: string,
    roomId: string,
  ): boolean;
  /** Forget an invite the homeserver refused, so the next escalation tries again. */
  forgetEscalationInvite(boardId: string, userId: string): void;
  /** Record an invitee's first join. The invite when this call recorded it; null otherwise. */
  recordInviteJoined(boardId: string, userId: string): EscalationInvite | null;
  /** Invites whose join still owes re-posts, under `maxAttempts` passes. */
  invitesOwingReposts(maxAttempts: number): EscalationInvite[];
  /** Count one re-post pass for an invite. */
  countRepostAttempt(boardId: string, userId: string): void;
  /** Record that an invite's join is fully re-posted. */
  recordInviteReposted(boardId: string, userId: string): void;

  /** Claim a check set's checks.waiting card. True once per board and arrival. */
  claimChecksWaiting(
    input: Omit<
      ChecksWaiting,
      "eventId" | "claimedAt" | "postedAt" | "closedAt"
    >,
  ): boolean;
  checksWaiting(boardId: string, arrivalId: string): ChecksWaiting | null;
  /** Record a checks.waiting card's event, and that it is posted. */
  recordChecksWaitingPosted(
    boardId: string,
    arrivalId: string,
    eventId: string,
  ): void;
  /** The posted checks.waiting card whose current event is this one, or null. */
  checksWaitingByEvent(eventId: string): ChecksWaiting | null;
  /** The newest posted, open checks.waiting card for this card and stage in this room, or null. */
  openChecksWaiting(
    boardId: string,
    cardId: string,
    stageKey: string,
    roomId: string,
  ): ChecksWaiting | null;
  /** Close a checks.waiting card: its checks are over. */
  closeChecksWaiting(boardId: string, arrivalId: string): void;
  /** Point an open checks.waiting card at a new copy, only while it points at the old one. */
  moveChecksWaiting(
    boardId: string,
    arrivalId: string,
    was: string,
    to: string,
  ): boolean;

  /** The encryption device recorded for a user, or null. */
  cryptoDevice(userId: string): string | null;
  /**
   * Record a user's encryption device. The first record wins: answers the device on record
   * afterwards, which is this one unless another was recorded first.
   */
  recordCryptoDevice(userId: string, deviceId: string): string;
  /** Forget a user's device: its keys are gone, and the next start takes a new one. */
  forgetCryptoDevice(userId: string): void;

  /**
   * Park an encrypted event until its key arrives. True when newly parked, false when it was
   * already waiting. Over `max` waiting, the oldest are dropped.
   */
  parkPendingDecrypt(
    eventId: string,
    roomId: string,
    event: Record<string, unknown>,
    max: number,
  ): boolean;
  /** Every parked event, oldest first. */
  pendingDecrypts(): PendingDecrypt[];
  /**
   * Take a parked event off the list. True only for the caller that removed it, so two retries
   * never act on the same event twice.
   */
  claimPendingDecrypt(eventId: string): boolean;
  close(): void;
}
