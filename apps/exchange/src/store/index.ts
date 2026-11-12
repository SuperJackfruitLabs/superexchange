/**
 * The service's own store: one SQLite database (`bun:sqlite`, WAL) in the data directory. It
 * holds what SuperExchange alone knows: the homeserver transactions already applied, the boards
 * an operator has pointed at it, the gates the event relay delivered for them, each board's room
 * and who is in it (and whether it is end-to-end encrypted), which gates have been posted there
 * with what they offered, whether a person's answer to each has acted and its receipt been
 * posted, which gates the board says were decided elsewhere and settled here, the questions the
 * relay delivered and the ones posted (with what they offered, and whether their receipt has been
 * claimed), the delivery follow-ups and waiting cards likewise, the board-room notices (reminders,
 * escalations and whom they invited, quorum progress, held approvals, checks) and the checks.waiting
 * cards, the speaker's encryption device, and encrypted events still waiting for their key.
 *
 * The lowest layer beside config: it knows tables, not Matrix and not boards' rules. Its schema
 * is a list of migrations applied in order at boot and recorded in `PRAGMA user_version`; a
 * database written by a newer build is refused rather than guessed at.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The database's file name inside the data directory. */
export const DATABASE_FILE = "superexchange.sqlite";

/**
 * The schema, one entry per version. Append only: a shipped entry is never edited, because a
 * database that already applied it would never see the change.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE as_transactions (
     txn_id TEXT PRIMARY KEY,
     received_at TEXT NOT NULL
   );
   CREATE TABLE boards (
     board_id TEXT PRIMARY KEY,
     sp_tenant_id TEXT NOT NULL,
     org_id TEXT NOT NULL,
     invitees TEXT NOT NULL,
     enabled INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE gate_deliveries (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL
   );
   CREATE INDEX gate_deliveries_board ON gate_deliveries (board_id);`,
  `CREATE TABLE board_rooms (
     board_id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL UNIQUE,
     alias TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE room_members (
     room_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     membership TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (room_id, user_id)
   );
   CREATE TABLE gate_events (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     card_event_id TEXT,
     prose_event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT
   );
   CREATE INDEX gate_events_room ON gate_events (room_id);`,
  `ALTER TABLE gate_events ADD COLUMN options TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_id TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_digest TEXT;
   ALTER TABLE gate_events ADD COLUMN subject_preview_complete INTEGER;
   ALTER TABLE gate_events ADD COLUMN variants TEXT;
   ALTER TABLE gate_events ADD COLUMN quorum TEXT;
   ALTER TABLE gate_events ADD COLUMN outcome_claimed_at TEXT;
   ALTER TABLE gate_events ADD COLUMN outcome_posted_at TEXT;`,
  // Every room recorded before this migration was made without encryption, so 0 is the truth
  // for them, not a guess.
  `ALTER TABLE board_rooms ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE crypto_devices (
     user_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE pending_decrypts (
     event_id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
     event TEXT NOT NULL,
     first_seen_at TEXT NOT NULL
   );
   CREATE INDEX pending_decrypts_seen ON pending_decrypts (first_seen_at);`,
  // The sweep: a gate the board says was decided elsewhere. A posted gate's receipt is claimed
  // with the outcome columns of migration 3, so the answer path and the sweep share one claim;
  // these record that the sweep made it and with what. A delivery settled before it was ever
  // posted is never posted.
  `ALTER TABLE gate_events ADD COLUMN settled_at TEXT;
   ALTER TABLE gate_events ADD COLUMN settled_decision TEXT;
   ALTER TABLE gate_deliveries ADD COLUMN settled_at TEXT;`,
  // Board questions (elicitation.pending): what the relay or the sweep delivered, and each one
  // posted into its room with what it offered, so an answer is judged against what was shown. A
  // question is one event (its prose, the v1 card inside it); `outcome_posted_at` is its one
  // receipt, claimed by the answer path or by the sweep when the board no longer waits on it.
  `CREATE TABLE question_deliveries (
     elicitation_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT
   );
   CREATE INDEX question_deliveries_board ON question_deliveries (board_id);
   CREATE TABLE question_events (
     elicitation_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     options_v2 TEXT NOT NULL,
     free_text_max_length INTEGER,
     subject_id TEXT,
     subject_digest TEXT,
     subject_preview_complete INTEGER,
     subject_expires_at TEXT,
     approval_request INTEGER NOT NULL,
     outcome_posted_at TEXT,
     settled_at TEXT
   );
   CREATE INDEX question_events_room ON question_events (room_id);
   CREATE INDEX question_events_board ON question_events (board_id);`,
  // Delivery follow-ups (delivery.pending, keyed by the gate they follow) and waiting cards
  // (attention.pending, keyed by board, card and wait): what the relay or the sweep delivered, and
  // each one posted into its room with what it offered, so an answer is judged against what was
  // shown. Each is one event; `outcome_posted_at` is its one receipt, claimed by the answer path or
  // by the sweep when the board no longer lists it.
  `CREATE TABLE followup_deliveries (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT
   );
   CREATE INDEX followup_deliveries_board ON followup_deliveries (board_id);
   CREATE TABLE followup_events (
     gate_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     subject_preview_complete INTEGER,
     outcome_posted_at TEXT,
     settled_at TEXT
   );
   CREATE INDEX followup_events_board ON followup_events (board_id);
   CREATE TABLE attention_deliveries (
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     wait_id TEXT NOT NULL,
     received_at TEXT NOT NULL,
     body TEXT NOT NULL,
     settled_at TEXT,
     PRIMARY KEY (board_id, card_id, wait_id)
   );
   CREATE TABLE attention_events (
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     wait_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     options TEXT NOT NULL,
     outcome_posted_at TEXT,
     settled_at TEXT,
     PRIMARY KEY (board_id, card_id, wait_id)
   );`,
  // Board-room notices: a decision's reminder or escalation, a quorum gate's approval, a held
  // approval released or pulled back, a check failed or overridden. Each is recorded once under
  // its key (what makes it the same notice when it is delivered again), claimed with the room and
  // the card it replies to before anything is sent, and posted once. One that has nothing true to
  // say (its card never posted here, or already settled) is dropped, and never posted after.
  // An escalation's invites are recorded once per board and person, so somebody who leaves is not
  // invited back, and their join owes the open escalations one re-post. A check set's escalation
  // posts one checks.waiting card (keyed by its arrival), which an override must reference.
  `CREATE TABLE notices (
     notice_id TEXT PRIMARY KEY,
     notice TEXT NOT NULL,
     board_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     decision_kind TEXT,
     decision_id TEXT,
     body TEXT NOT NULL,
     received_at TEXT NOT NULL,
     room_id TEXT,
     reply_to TEXT,
     claimed_at TEXT,
     prose_event_id TEXT,
     posted_at TEXT,
     dropped_at TEXT,
     reposted_at TEXT,
     card_moved_at TEXT
   );
   CREATE INDEX notices_board ON notices (board_id);
   CREATE TABLE escalation_invites (
     board_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     room_id TEXT NOT NULL,
     invited_at TEXT NOT NULL,
     joined_at TEXT,
     reposted_at TEXT,
     repost_attempts INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (board_id, user_id)
   );
   CREATE TABLE checks_waiting (
     board_id TEXT NOT NULL,
     arrival_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     card_title TEXT NOT NULL,
     stage_key TEXT NOT NULL,
     stage_name TEXT,
     room_id TEXT NOT NULL,
     event_id TEXT,
     claimed_at TEXT NOT NULL,
     posted_at TEXT,
     closed_at TEXT,
     PRIMARY KEY (board_id, arrival_id)
   );
   CREATE INDEX checks_waiting_event ON checks_waiting (event_id);`,
  // 9. Board chat tells a person linked to nobody how to link, at most once a day in a room.
  `CREATE TABLE link_hints (
     sender TEXT NOT NULL,
     room_id TEXT NOT NULL,
     day TEXT NOT NULL,
     PRIMARY KEY (sender, room_id, day)
   );`,
];

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

interface BoardRow {
  board_id: string;
  sp_tenant_id: string;
  org_id: string;
  invitees: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Open (creating if need be) the store in `dataDir`, and bring its schema up to date. */
export function openStore(
  dataDir: string,
  { now = () => new Date() }: { now?: () => Date } = {},
): Store {
  let db: Database;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, DATABASE_FILE), {
      create: true,
      strict: true,
    });
  } catch (error) {
    // The path is a setting's value, and fs and SQLite errors quote it: only the code is kept.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    throw new StoreError(
      `the store cannot be opened in SUPEREXCHANGE_DATA_DIR (${code})`,
    );
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const stamp = () => now().toISOString();
  const toBoard = (row: BoardRow): Board => ({
    boardId: row.board_id,
    spTenantId: row.sp_tenant_id,
    orgId: row.org_id,
    invitees: JSON.parse(row.invitees) as string[],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const getBoard = (boardId: string): Board | null => {
    const row = db
      .query<BoardRow, [string]>("SELECT * FROM boards WHERE board_id = ?")
      .get(boardId);
    return row ? toBoard(row) : null;
  };

  const boardRoom = (boardId: string): BoardRoom | null => {
    const row = db
      .query<
        BoardRoomRow,
        [string]
      >("SELECT * FROM board_rooms WHERE board_id = ?")
      .get(boardId);
    return row ? toBoardRoom(row) : null;
  };

  return {
    schemaVersion: () => userVersion(db),

    claimTransaction(txnId) {
      const result = db
        .query(
          "INSERT INTO as_transactions (txn_id, received_at) VALUES (?, ?) ON CONFLICT (txn_id) DO NOTHING",
        )
        .run(txnId, stamp());
      return result.changes === 1;
    },

    upsertBoard(input) {
      const at = stamp();
      db.query(
        `INSERT INTO boards (board_id, sp_tenant_id, org_id, invitees, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (board_id) DO UPDATE SET
           sp_tenant_id = excluded.sp_tenant_id,
           org_id = excluded.org_id,
           invitees = excluded.invitees,
           enabled = 1,
           updated_at = excluded.updated_at`,
      ).run(
        input.boardId,
        input.spTenantId,
        input.orgId,
        JSON.stringify(input.invitees),
        at,
        at,
      );
      return getBoard(input.boardId) as Board;
    },

    disableBoard(boardId) {
      db.query(
        "UPDATE boards SET enabled = 0, updated_at = ? WHERE board_id = ?",
      ).run(stamp(), boardId);
      return getBoard(boardId);
    },

    getBoard,

    listBoards() {
      return db
        .query<BoardRow, []>("SELECT * FROM boards ORDER BY board_id")
        .all()
        .map(toBoard);
    },

    recordGateDelivery(gateId, boardId, body) {
      const result = db
        .query(
          "INSERT INTO gate_deliveries (gate_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING",
        )
        .run(gateId, boardId, stamp(), JSON.stringify(body));
      return result.changes === 1;
    },

    gateDelivery(gateId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM gate_deliveries WHERE gate_id = ?")
        .get(gateId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    settleGateDelivery(gateId) {
      return (
        db
          .query(
            "UPDATE gate_deliveries SET settled_at = ? WHERE gate_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    unpostedGates(boardId) {
      const rows = db
        .query<
          { gate_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.gate_id, d.board_id, d.body FROM gate_deliveries d
           LEFT JOIN gate_events e ON e.gate_id = d.gate_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.gate_id`,
        )
        .all(boardId ?? null, boardId ?? null);
      return rows.map((row) => ({
        gateId: row.gate_id,
        boardId: row.board_id,
        body: JSON.parse(row.body) as unknown,
      }));
    },

    recordBoardRoom(boardId, roomId, alias, encrypted) {
      db.query(
        "INSERT INTO board_rooms (board_id, room_id, alias, encrypted, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (board_id) DO NOTHING",
      ).run(boardId, roomId, alias, encrypted ? 1 : 0, stamp());
      return boardRoom(boardId) as BoardRoom;
    },

    boardRoom,

    boardRoomByRoomId(roomId) {
      const row = db
        .query<
          BoardRoomRow,
          [string]
        >("SELECT * FROM board_rooms WHERE room_id = ?")
        .get(roomId);
      return row ? toBoardRoom(row) : null;
    },

    recordMembership(roomId, userId, membership) {
      db.query(
        `INSERT INTO room_members (room_id, user_id, membership, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, user_id) DO UPDATE SET
           membership = excluded.membership,
           updated_at = excluded.updated_at`,
      ).run(roomId, userId, membership, stamp());
    },

    membersOf(roomId, membership) {
      return db
        .query<{ user_id: string }, [string, string]>(
          "SELECT user_id FROM room_members WHERE room_id = ? AND membership = ? ORDER BY user_id",
        )
        .all(roomId, membership)
        .map((row) => row.user_id);
    },

    membershipOf(roomId, userId) {
      const row = db
        .query<
          { membership: string },
          [string, string]
        >("SELECT membership FROM room_members WHERE room_id = ? AND user_id = ?")
        .get(roomId, userId);
      return row?.membership ?? null;
    },

    claimGateEvent(gateId, boardId, roomId, offer) {
      const result = db
        .query(
          `INSERT INTO gate_events (gate_id, board_id, room_id, claimed_at, options, subject_id,
             subject_digest, subject_preview_complete, variants, quorum)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING`,
        )
        .run(
          gateId,
          boardId,
          roomId,
          stamp(),
          offer ? JSON.stringify(offer.options) : null,
          offer?.subjectId ?? null,
          offer?.subjectDigest ?? null,
          offer?.subjectPreviewComplete == null
            ? null
            : offer.subjectPreviewComplete
              ? 1
              : 0,
          offer?.variants ? JSON.stringify(offer.variants) : null,
          offer?.quorum == null ? null : JSON.stringify(offer.quorum),
        );
      return result.changes === 1;
    },

    gateEvent(gateId) {
      const row = db
        .query<
          GateEventRow,
          [string]
        >("SELECT * FROM gate_events WHERE gate_id = ?")
        .get(gateId);
      return row ? toGateEvent(row) : null;
    },

    recordGateProse(gateId, proseEventId) {
      db.query(
        "UPDATE gate_events SET prose_event_id = ? WHERE gate_id = ?",
      ).run(proseEventId, gateId);
    },

    recordGatePosted(gateId, cardEventId) {
      db.query(
        "UPDATE gate_events SET card_event_id = ?, posted_at = ? WHERE gate_id = ?",
      ).run(cardEventId, stamp(), gateId);
    },

    claimGateOutcome(gateId) {
      const result = db
        .query(
          "UPDATE gate_events SET outcome_claimed_at = ? WHERE gate_id = ? AND outcome_claimed_at IS NULL",
        )
        .run(stamp(), gateId);
      return result.changes === 1;
    },

    releaseGateOutcome(gateId) {
      db.query(
        "UPDATE gate_events SET outcome_claimed_at = NULL WHERE gate_id = ? AND outcome_posted_at IS NULL",
      ).run(gateId);
    },

    claimGateReceipt(gateId) {
      const result = db
        .query(
          "UPDATE gate_events SET outcome_posted_at = ? WHERE gate_id = ? AND outcome_posted_at IS NULL",
        )
        .run(stamp(), gateId);
      return result.changes === 1;
    },

    claimLinkHint(sender, roomId, day) {
      db.query("DELETE FROM link_hints WHERE day < ?").run(day);
      const result = db
        .query(
          "INSERT OR IGNORE INTO link_hints (sender, room_id, day) VALUES (?, ?, ?)",
        )
        .run(sender, roomId, day);
      return result.changes === 1;
    },

    settleGateEvent(gateId, decision) {
      const at = stamp();
      return (
        db
          .query(
            `UPDATE gate_events SET
               outcome_claimed_at = COALESCE(outcome_claimed_at, ?1),
               outcome_posted_at = ?1,
               settled_at = ?1,
               settled_decision = ?2
             WHERE gate_id = ?3 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(at, decision, gateId).changes === 1
      );
    },

    postedGatesAwaitingOutcome(boardId) {
      return db
        .query<GateEventRow, [string]>(
          `SELECT * FROM gate_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, gate_id`,
        )
        .all(boardId)
        .map(toGateEvent);
    },

    releaseUnfinishedOutcomes() {
      return db
        .query(
          "UPDATE gate_events SET outcome_claimed_at = NULL WHERE outcome_claimed_at IS NOT NULL AND outcome_posted_at IS NULL",
        )
        .run().changes;
    },

    recordQuestionDelivery(elicitationId, boardId, body) {
      return (
        db
          .query(
            "INSERT INTO question_deliveries (elicitation_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (elicitation_id) DO NOTHING",
          )
          .run(elicitationId, boardId, stamp(), JSON.stringify(body))
          .changes === 1
      );
    },

    questionDelivery(elicitationId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM question_deliveries WHERE elicitation_id = ?")
        .get(elicitationId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    unpostedQuestions(boardId) {
      return db
        .query<
          { elicitation_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.elicitation_id, d.board_id, d.body FROM question_deliveries d
           LEFT JOIN question_events e ON e.elicitation_id = d.elicitation_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.elicitation_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          elicitationId: row.elicitation_id,
          boardId: row.board_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleQuestionDelivery(elicitationId) {
      return (
        db
          .query(
            "UPDATE question_deliveries SET settled_at = ? WHERE elicitation_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), elicitationId).changes === 1
      );
    },

    claimQuestionEvent(elicitationId, boardId, roomId, offer) {
      return (
        db
          .query(
            `INSERT INTO question_events (elicitation_id, board_id, room_id, claimed_at, options,
               options_v2, free_text_max_length, subject_id, subject_digest,
               subject_preview_complete, subject_expires_at, approval_request)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (elicitation_id) DO NOTHING`,
          )
          .run(
            elicitationId,
            boardId,
            roomId,
            stamp(),
            JSON.stringify(offer.options),
            JSON.stringify(offer.optionsV2),
            offer.freeTextMaxLength,
            offer.subject?.id ?? null,
            offer.subject?.digest ?? null,
            offer.subject ? (offer.subject.previewComplete ? 1 : 0) : null,
            offer.subject?.expiresAt ?? null,
            offer.approvalRequest ? 1 : 0,
          ).changes === 1
      );
    },

    questionEvent(elicitationId) {
      const row = db
        .query<
          QuestionEventRow,
          [string]
        >("SELECT * FROM question_events WHERE elicitation_id = ?")
        .get(elicitationId);
      return row ? toQuestionEvent(row) : null;
    },

    recordQuestionPosted(elicitationId, eventId) {
      db.query(
        "UPDATE question_events SET event_id = ?, posted_at = ? WHERE elicitation_id = ?",
      ).run(eventId, stamp(), elicitationId);
    },

    openQuestionsInRoom(roomId) {
      return db
        .query<QuestionEventRow, [string]>(
          `SELECT * FROM question_events
           WHERE room_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at DESC, rowid DESC`,
        )
        .all(roomId)
        .map(toQuestionEvent);
    },

    claimQuestionReceipt(elicitationId) {
      return (
        db
          .query(
            "UPDATE question_events SET outcome_posted_at = ? WHERE elicitation_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), elicitationId).changes === 1
      );
    },

    settleQuestionEvent(elicitationId) {
      const at = stamp();
      return (
        db
          .query(
            "UPDATE question_events SET outcome_posted_at = ?1, settled_at = ?1 WHERE elicitation_id = ?2 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(at, elicitationId).changes === 1
      );
    },

    postedQuestionsAwaitingOutcome(boardId) {
      return db
        .query<QuestionEventRow, [string]>(
          `SELECT * FROM question_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toQuestionEvent);
    },

    recordFollowupDelivery(gateId, boardId, body) {
      return (
        db
          .query(
            "INSERT INTO followup_deliveries (gate_id, board_id, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING",
          )
          .run(gateId, boardId, stamp(), JSON.stringify(body)).changes === 1
      );
    },

    followupDelivery(gateId) {
      const row = db
        .query<
          { board_id: string; body: string; settled_at: string | null },
          [string]
        >("SELECT board_id, body, settled_at FROM followup_deliveries WHERE gate_id = ?")
        .get(gateId);
      return row
        ? {
            boardId: row.board_id,
            body: JSON.parse(row.body) as unknown,
            settledAt: row.settled_at,
          }
        : null;
    },

    unpostedFollowups(boardId) {
      return db
        .query<
          { gate_id: string; board_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.gate_id, d.board_id, d.body FROM followup_deliveries d
           LEFT JOIN followup_events e ON e.gate_id = d.gate_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.gate_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          gateId: row.gate_id,
          boardId: row.board_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleFollowupDelivery(gateId) {
      return (
        db
          .query(
            "UPDATE followup_deliveries SET settled_at = ? WHERE gate_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    claimFollowupEvent(gateId, boardId, cardId, roomId, offer) {
      return (
        db
          .query(
            `INSERT INTO followup_events (gate_id, board_id, card_id, room_id, claimed_at, options,
               subject_preview_complete)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gate_id) DO NOTHING`,
          )
          .run(
            gateId,
            boardId,
            cardId,
            roomId,
            stamp(),
            JSON.stringify(offer.options),
            offer.subjectPreviewComplete === null
              ? null
              : offer.subjectPreviewComplete
                ? 1
                : 0,
          ).changes === 1
      );
    },

    followupEvent(gateId) {
      const row = db
        .query<
          FollowupEventRow,
          [string]
        >("SELECT * FROM followup_events WHERE gate_id = ?")
        .get(gateId);
      return row ? toFollowupEvent(row) : null;
    },

    recordFollowupPosted(gateId, eventId) {
      db.query(
        "UPDATE followup_events SET event_id = ?, posted_at = ? WHERE gate_id = ?",
      ).run(eventId, stamp(), gateId);
    },

    claimFollowupReceipt(gateId) {
      return (
        db
          .query(
            "UPDATE followup_events SET outcome_posted_at = ? WHERE gate_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    settleFollowupEvent(gateId) {
      return (
        db
          .query(
            "UPDATE followup_events SET outcome_posted_at = ?1, settled_at = ?1 WHERE gate_id = ?2 AND posted_at IS NOT NULL AND outcome_posted_at IS NULL",
          )
          .run(stamp(), gateId).changes === 1
      );
    },

    postedFollowupsAwaitingOutcome(boardId) {
      return db
        .query<FollowupEventRow, [string]>(
          `SELECT * FROM followup_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toFollowupEvent);
    },

    recordAttentionDelivery(key, body) {
      return (
        db
          .query(
            `INSERT INTO attention_deliveries (board_id, card_id, wait_id, received_at, body)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (board_id, card_id, wait_id) DO NOTHING`,
          )
          .run(
            key.boardId,
            key.cardId,
            key.waitId,
            stamp(),
            JSON.stringify(body),
          ).changes === 1
      );
    },

    attentionDelivery(key) {
      const row = db
        .query<
          { body: string; settled_at: string | null },
          [string, string, string]
        >("SELECT body, settled_at FROM attention_deliveries WHERE board_id = ? AND card_id = ? AND wait_id = ?")
        .get(key.boardId, key.cardId, key.waitId);
      return row
        ? { body: JSON.parse(row.body) as unknown, settledAt: row.settled_at }
        : null;
    },

    unpostedAttention(boardId) {
      return db
        .query<
          { board_id: string; card_id: string; wait_id: string; body: string },
          [string | null, string | null]
        >(
          `SELECT d.board_id, d.card_id, d.wait_id, d.body FROM attention_deliveries d
           LEFT JOIN attention_events e
             ON e.board_id = d.board_id AND e.card_id = d.card_id AND e.wait_id = d.wait_id
           WHERE e.posted_at IS NULL AND d.settled_at IS NULL
             AND (?1 IS NULL OR d.board_id = ?2)
           ORDER BY d.received_at, d.board_id, d.card_id, d.wait_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map((row) => ({
          boardId: row.board_id,
          cardId: row.card_id,
          waitId: row.wait_id,
          body: JSON.parse(row.body) as unknown,
        }));
    },

    settleAttentionDelivery(key) {
      return (
        db
          .query(
            "UPDATE attention_deliveries SET settled_at = ? WHERE board_id = ? AND card_id = ? AND wait_id = ? AND settled_at IS NULL",
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    claimAttentionEvent(key, roomId, options) {
      return (
        db
          .query(
            `INSERT INTO attention_events (board_id, card_id, wait_id, room_id, claimed_at, options)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (board_id, card_id, wait_id) DO NOTHING`,
          )
          .run(
            key.boardId,
            key.cardId,
            key.waitId,
            roomId,
            stamp(),
            JSON.stringify(options),
          ).changes === 1
      );
    },

    attentionEvent(key) {
      const row = db
        .query<
          AttentionEventRow,
          [string, string, string]
        >("SELECT * FROM attention_events WHERE board_id = ? AND card_id = ? AND wait_id = ?")
        .get(key.boardId, key.cardId, key.waitId);
      return row ? toAttentionEvent(row) : null;
    },

    recordAttentionPosted(key, eventId) {
      db.query(
        "UPDATE attention_events SET event_id = ?, posted_at = ? WHERE board_id = ? AND card_id = ? AND wait_id = ?",
      ).run(eventId, stamp(), key.boardId, key.cardId, key.waitId);
    },

    claimAttentionReceipt(key) {
      return (
        db
          .query(
            `UPDATE attention_events SET outcome_posted_at = ?
             WHERE board_id = ? AND card_id = ? AND wait_id = ?
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    settleAttentionEvent(key) {
      return (
        db
          .query(
            `UPDATE attention_events SET outcome_posted_at = ?1, settled_at = ?1
             WHERE board_id = ?2 AND card_id = ?3 AND wait_id = ?4
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(stamp(), key.boardId, key.cardId, key.waitId).changes === 1
      );
    },

    postedAttentionAwaitingOutcome(boardId) {
      return db
        .query<AttentionEventRow, [string]>(
          `SELECT * FROM attention_events
           WHERE board_id = ? AND posted_at IS NOT NULL AND outcome_posted_at IS NULL
           ORDER BY posted_at, rowid`,
        )
        .all(boardId)
        .map(toAttentionEvent);
    },

    cryptoDevice(userId) {
      const row = db
        .query<
          { device_id: string },
          [string]
        >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
        .get(userId);
      return row?.device_id ?? null;
    },

    recordCryptoDevice(userId, deviceId) {
      db.query(
        "INSERT INTO crypto_devices (user_id, device_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
      ).run(userId, deviceId, stamp());
      return (
        db
          .query<
            { device_id: string },
            [string]
          >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
          .get(userId)?.device_id ?? deviceId
      );
    },

    forgetCryptoDevice(userId) {
      db.query("DELETE FROM crypto_devices WHERE user_id = ?").run(userId);
    },

    parkPendingDecrypt(eventId, roomId, event, max) {
      return db.transaction(() => {
        const inserted = db
          .query(
            "INSERT INTO pending_decrypts (event_id, room_id, event, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
          )
          .run(eventId, roomId, JSON.stringify(event), stamp()).changes;
        if (inserted !== 1) return false;
        db.query(
          `DELETE FROM pending_decrypts WHERE event_id IN (
             SELECT event_id FROM pending_decrypts
             ORDER BY first_seen_at DESC, event_id DESC LIMIT -1 OFFSET ?
           )`,
        ).run(max);
        return true;
      })();
    },

    pendingDecrypts() {
      return db
        .query<
          {
            event_id: string;
            room_id: string;
            event: string;
            first_seen_at: string;
          },
          []
        >("SELECT * FROM pending_decrypts ORDER BY first_seen_at, event_id")
        .all()
        .map((row) => ({
          eventId: row.event_id,
          roomId: row.room_id,
          event: JSON.parse(row.event) as Record<string, unknown>,
          firstSeenAt: row.first_seen_at,
        }));
    },

    claimPendingDecrypt(eventId) {
      return (
        db.query("DELETE FROM pending_decrypts WHERE event_id = ?").run(eventId)
          .changes === 1
      );
    },

    moveGateEvent(gateId, was, to) {
      return (
        db
          .query(
            `UPDATE gate_events SET prose_event_id = ?, card_event_id = ?
             WHERE gate_id = ? AND prose_event_id IS ? AND card_event_id IS ?
               AND posted_at IS NOT NULL AND outcome_posted_at IS NULL`,
          )
          .run(
            to.proseEventId,
            to.cardEventId,
            gateId,
            was.proseEventId,
            was.cardEventId,
          ).changes === 1
      );
    },

    recordGateQuorum(gateId, quorum) {
      return db.transaction(() => {
        const row = db
          .query<
            { quorum: string | null },
            [string]
          >("SELECT quorum FROM gate_events WHERE gate_id = ? AND outcome_posted_at IS NULL")
          .get(gateId);
        if (!row) return false;
        const recorded =
          row.quorum === null ? null : (JSON.parse(row.quorum) as unknown);
        const had =
          typeof recorded === "object" &&
          recorded !== null &&
          Array.isArray((recorded as { approvals?: unknown }).approvals)
            ? (recorded as { approvals: unknown[] }).approvals.length
            : -1;
        // Never walked back by a late redelivery of an earlier approval, which carries fewer.
        if (had > quorum.approvals.length) return false;
        db.query("UPDATE gate_events SET quorum = ? WHERE gate_id = ?").run(
          JSON.stringify(quorum),
          gateId,
        );
        return true;
      })();
    },

    moveQuestionEvent(elicitationId, was, to) {
      return (
        db
          .query(
            "UPDATE question_events SET event_id = ? WHERE elicitation_id = ? AND event_id = ? AND outcome_posted_at IS NULL",
          )
          .run(to, elicitationId, was).changes === 1
      );
    },

    moveFollowupEvent(gateId, was, to) {
      return (
        db
          .query(
            "UPDATE followup_events SET event_id = ? WHERE gate_id = ? AND event_id = ? AND outcome_posted_at IS NULL",
          )
          .run(to, gateId, was).changes === 1
      );
    },

    moveAttentionEvent(key, was, to) {
      return (
        db
          .query(
            `UPDATE attention_events SET event_id = ?
             WHERE board_id = ? AND card_id = ? AND wait_id = ? AND event_id = ? AND outcome_posted_at IS NULL`,
          )
          .run(to, key.boardId, key.cardId, key.waitId, was).changes === 1
      );
    },

    recordNotice(input) {
      return (
        db
          .query(
            `INSERT INTO notices (notice_id, notice, board_id, card_id, decision_kind, decision_id, body, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (notice_id) DO NOTHING`,
          )
          .run(
            input.noticeId,
            input.notice,
            input.boardId,
            input.cardId,
            input.decisionKind,
            input.decisionId,
            JSON.stringify(input.body),
            stamp(),
          ).changes === 1
      );
    },

    notice(noticeId) {
      const row = db
        .query<NoticeRow, [string]>("SELECT * FROM notices WHERE notice_id = ?")
        .get(noticeId);
      return row ? toNotice(row) : null;
    },

    unpostedNotices(boardId) {
      return db
        .query<NoticeRow, [string | null, string | null]>(
          `SELECT * FROM notices
           WHERE posted_at IS NULL AND dropped_at IS NULL AND (?1 IS NULL OR board_id = ?2)
           ORDER BY received_at, notice_id`,
        )
        .all(boardId ?? null, boardId ?? null)
        .map(toNotice);
    },

    claimNotice(noticeId, roomId, replyTo) {
      return (
        db
          .query(
            `UPDATE notices SET room_id = ?, reply_to = ?, claimed_at = ?
             WHERE notice_id = ? AND claimed_at IS NULL AND dropped_at IS NULL`,
          )
          .run(roomId, replyTo, stamp(), noticeId).changes === 1
      );
    },

    recordNoticeProse(noticeId, eventId) {
      db.query("UPDATE notices SET prose_event_id = ? WHERE notice_id = ?").run(
        eventId,
        noticeId,
      );
    },

    recordNoticePosted(noticeId) {
      db.query(
        "UPDATE notices SET posted_at = ? WHERE notice_id = ? AND posted_at IS NULL",
      ).run(stamp(), noticeId);
    },

    dropNotice(noticeId) {
      return (
        db
          .query(
            "UPDATE notices SET dropped_at = ? WHERE notice_id = ? AND claimed_at IS NULL AND dropped_at IS NULL",
          )
          .run(stamp(), noticeId).changes === 1
      );
    },

    postedEscalations(boardId) {
      return db
        .query<NoticeRow, [string]>(
          `SELECT * FROM notices WHERE board_id = ? AND notice = 'escalated' AND posted_at IS NOT NULL
           ORDER BY posted_at, notice_id`,
        )
        .all(boardId)
        .map(toNotice);
    },

    claimNoticeRepost(noticeId, joinedAt) {
      return (
        db
          .query(
            `UPDATE notices SET reposted_at = ?
             WHERE notice_id = ? AND (reposted_at IS NULL OR reposted_at < ?)`,
          )
          .run(stamp(), noticeId, joinedAt).changes === 1
      );
    },

    releaseNoticeRepost(noticeId, previous) {
      db.query("UPDATE notices SET reposted_at = ? WHERE notice_id = ?").run(
        previous,
        noticeId,
      );
    },

    recordNoticeCardMoved(noticeId) {
      db.query("UPDATE notices SET card_moved_at = ? WHERE notice_id = ?").run(
        stamp(),
        noticeId,
      );
    },

    knownCardTitle(boardId, cardId) {
      const rows = db
        .query<{ body: string }, [string, string]>(
          `SELECT body FROM notices WHERE board_id = ? AND card_id = ? AND notice IN ('reminded', 'escalated')
           ORDER BY received_at DESC, notice_id DESC`,
        )
        .all(boardId, cardId);
      for (const row of rows) {
        const title = (JSON.parse(row.body) as { cardTitle?: unknown })
          .cardTitle;
        if (typeof title === "string" && title.trim() !== "")
          return title.trim();
      }
      return null;
    },

    claimEscalationInvite(boardId, userId, roomId) {
      return (
        db
          .query(
            `INSERT INTO escalation_invites (board_id, user_id, room_id, invited_at)
             VALUES (?, ?, ?, ?) ON CONFLICT (board_id, user_id) DO NOTHING`,
          )
          .run(boardId, userId, roomId, stamp()).changes === 1
      );
    },

    forgetEscalationInvite(boardId, userId) {
      db.query(
        "DELETE FROM escalation_invites WHERE board_id = ? AND user_id = ?",
      ).run(boardId, userId);
    },

    recordInviteJoined(boardId, userId) {
      const at = stamp();
      const changed = db
        .query(
          "UPDATE escalation_invites SET joined_at = ? WHERE board_id = ? AND user_id = ? AND joined_at IS NULL",
        )
        .run(at, boardId, userId).changes;
      if (changed !== 1) return null;
      const row = db
        .query<
          EscalationInviteRow,
          [string, string]
        >("SELECT * FROM escalation_invites WHERE board_id = ? AND user_id = ?")
        .get(boardId, userId);
      return row ? toEscalationInvite(row) : null;
    },

    invitesOwingReposts(maxAttempts) {
      return db
        .query<EscalationInviteRow, [number]>(
          `SELECT * FROM escalation_invites
           WHERE joined_at IS NOT NULL AND reposted_at IS NULL AND repost_attempts < ?
           ORDER BY joined_at, board_id, user_id`,
        )
        .all(maxAttempts)
        .map(toEscalationInvite);
    },

    countRepostAttempt(boardId, userId) {
      db.query(
        "UPDATE escalation_invites SET repost_attempts = repost_attempts + 1 WHERE board_id = ? AND user_id = ?",
      ).run(boardId, userId);
    },

    recordInviteReposted(boardId, userId) {
      db.query(
        "UPDATE escalation_invites SET reposted_at = ? WHERE board_id = ? AND user_id = ?",
      ).run(stamp(), boardId, userId);
    },

    claimChecksWaiting(input) {
      return (
        db
          .query(
            `INSERT INTO checks_waiting (board_id, arrival_id, card_id, card_title, stage_key, stage_name, room_id, claimed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (board_id, arrival_id) DO NOTHING`,
          )
          .run(
            input.boardId,
            input.arrivalId,
            input.cardId,
            input.cardTitle,
            input.stageKey,
            input.stageName,
            input.roomId,
            stamp(),
          ).changes === 1
      );
    },

    checksWaiting(boardId, arrivalId) {
      const row = db
        .query<
          ChecksWaitingRow,
          [string, string]
        >("SELECT * FROM checks_waiting WHERE board_id = ? AND arrival_id = ?")
        .get(boardId, arrivalId);
      return row ? toChecksWaiting(row) : null;
    },

    recordChecksWaitingPosted(boardId, arrivalId, eventId) {
      db.query(
        "UPDATE checks_waiting SET event_id = ?, posted_at = ? WHERE board_id = ? AND arrival_id = ?",
      ).run(eventId, stamp(), boardId, arrivalId);
    },

    checksWaitingByEvent(eventId) {
      const row = db
        .query<
          ChecksWaitingRow,
          [string]
        >("SELECT * FROM checks_waiting WHERE event_id = ? AND posted_at IS NOT NULL")
        .get(eventId);
      return row ? toChecksWaiting(row) : null;
    },

    openChecksWaiting(boardId, cardId, stageKey, roomId) {
      const row = db
        .query<ChecksWaitingRow, [string, string, string, string]>(
          `SELECT * FROM checks_waiting
           WHERE board_id = ? AND card_id = ? AND stage_key = ? AND room_id = ?
             AND posted_at IS NOT NULL AND closed_at IS NULL
           ORDER BY claimed_at DESC, arrival_id DESC LIMIT 1`,
        )
        .get(boardId, cardId, stageKey, roomId);
      return row ? toChecksWaiting(row) : null;
    },

    closeChecksWaiting(boardId, arrivalId) {
      db.query(
        "UPDATE checks_waiting SET closed_at = ? WHERE board_id = ? AND arrival_id = ? AND closed_at IS NULL",
      ).run(stamp(), boardId, arrivalId);
    },

    moveChecksWaiting(boardId, arrivalId, was, to) {
      return (
        db
          .query(
            `UPDATE checks_waiting SET event_id = ?
             WHERE board_id = ? AND arrival_id = ? AND event_id = ? AND closed_at IS NULL`,
          )
          .run(to, boardId, arrivalId, was).changes === 1
      );
    },

    close: () => db.close(),
  };
}

interface NoticeRow {
  notice_id: string;
  notice: string;
  board_id: string;
  card_id: string;
  decision_kind: string | null;
  decision_id: string | null;
  body: string;
  received_at: string;
  room_id: string | null;
  reply_to: string | null;
  claimed_at: string | null;
  prose_event_id: string | null;
  posted_at: string | null;
  dropped_at: string | null;
  reposted_at: string | null;
  card_moved_at: string | null;
}

const toNotice = (row: NoticeRow): Notice => ({
  noticeId: row.notice_id,
  notice: row.notice as NoticeKind,
  boardId: row.board_id,
  cardId: row.card_id,
  decisionKind: row.decision_kind,
  decisionId: row.decision_id,
  body: JSON.parse(row.body) as unknown,
  receivedAt: row.received_at,
  roomId: row.room_id,
  replyTo: row.reply_to,
  claimedAt: row.claimed_at,
  proseEventId: row.prose_event_id,
  postedAt: row.posted_at,
  droppedAt: row.dropped_at,
  repostedAt: row.reposted_at,
  cardMovedAt: row.card_moved_at,
});

interface EscalationInviteRow {
  board_id: string;
  user_id: string;
  room_id: string;
  invited_at: string;
  joined_at: string | null;
  reposted_at: string | null;
  repost_attempts: number;
}

const toEscalationInvite = (row: EscalationInviteRow): EscalationInvite => ({
  boardId: row.board_id,
  userId: row.user_id,
  roomId: row.room_id,
  invitedAt: row.invited_at,
  joinedAt: row.joined_at,
  repostedAt: row.reposted_at,
  repostAttempts: row.repost_attempts,
});

interface ChecksWaitingRow {
  board_id: string;
  arrival_id: string;
  card_id: string;
  card_title: string;
  stage_key: string;
  stage_name: string | null;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  closed_at: string | null;
}

const toChecksWaiting = (row: ChecksWaitingRow): ChecksWaiting => ({
  boardId: row.board_id,
  arrivalId: row.arrival_id,
  cardId: row.card_id,
  cardTitle: row.card_title,
  stageKey: row.stage_key,
  stageName: row.stage_name,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  closedAt: row.closed_at,
});

interface BoardRoomRow {
  board_id: string;
  room_id: string;
  alias: string;
  encrypted: number;
  created_at: string;
}

interface GateEventRow {
  gate_id: string;
  board_id: string;
  room_id: string;
  card_event_id: string | null;
  prose_event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string | null;
  subject_id: string | null;
  subject_digest: string | null;
  subject_preview_complete: number | null;
  variants: string | null;
  quorum: string | null;
  outcome_claimed_at: string | null;
  outcome_posted_at: string | null;
  settled_at: string | null;
  settled_decision: string | null;
}

const toGateEvent = (row: GateEventRow): GateEvent => ({
  gateId: row.gate_id,
  boardId: row.board_id,
  roomId: row.room_id,
  cardEventId: row.card_event_id,
  proseEventId: row.prose_event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  // No options means the gate was claimed before offers were recorded: it offered nothing known.
  offer:
    row.options === null
      ? null
      : {
          options: JSON.parse(row.options) as GateOfferOption[],
          subjectId: row.subject_id,
          subjectDigest: row.subject_digest,
          subjectPreviewComplete:
            row.subject_preview_complete === null
              ? null
              : row.subject_preview_complete === 1,
          variants:
            row.variants === null
              ? null
              : (JSON.parse(row.variants) as GateOfferVariant[]),
          quorum:
            row.quorum === null ? null : (JSON.parse(row.quorum) as unknown),
        },
  outcomeClaimedAt: row.outcome_claimed_at,
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
  settledDecision: row.settled_decision,
});

interface QuestionEventRow {
  elicitation_id: string;
  board_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  options_v2: string;
  free_text_max_length: number | null;
  subject_id: string | null;
  subject_digest: string | null;
  subject_preview_complete: number | null;
  subject_expires_at: string | null;
  approval_request: number;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toQuestionEvent = (row: QuestionEventRow): QuestionEvent => ({
  elicitationId: row.elicitation_id,
  boardId: row.board_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  offer: {
    options: JSON.parse(row.options) as Array<{ id: string; label: string }>,
    optionsV2: JSON.parse(row.options_v2) as QuestionOfferOption[],
    freeTextMaxLength: row.free_text_max_length,
    subject:
      row.subject_id === null || row.subject_digest === null
        ? null
        : {
            id: row.subject_id,
            digest: row.subject_digest,
            // Anything but a recorded 1 is not complete: an approval of it is refused.
            previewComplete: row.subject_preview_complete === 1,
            expiresAt: row.subject_expires_at,
          },
    approvalRequest: row.approval_request === 1,
  },
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

interface FollowupEventRow {
  gate_id: string;
  board_id: string;
  card_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  subject_preview_complete: number | null;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toFollowupEvent = (row: FollowupEventRow): FollowupEvent => ({
  gateId: row.gate_id,
  boardId: row.board_id,
  cardId: row.card_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  offer: {
    options: JSON.parse(row.options) as CardOfferOption[],
    subjectPreviewComplete:
      row.subject_preview_complete === null
        ? null
        : row.subject_preview_complete === 1,
  },
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

interface AttentionEventRow {
  board_id: string;
  card_id: string;
  wait_id: string;
  room_id: string;
  event_id: string | null;
  claimed_at: string;
  posted_at: string | null;
  options: string;
  outcome_posted_at: string | null;
  settled_at: string | null;
}

const toAttentionEvent = (row: AttentionEventRow): AttentionEvent => ({
  boardId: row.board_id,
  cardId: row.card_id,
  waitId: row.wait_id,
  roomId: row.room_id,
  eventId: row.event_id,
  claimedAt: row.claimed_at,
  postedAt: row.posted_at,
  options: JSON.parse(row.options) as CardOfferOption[],
  outcomePostedAt: row.outcome_posted_at,
  settledAt: row.settled_at,
});

const toBoardRoom = (row: BoardRoomRow): BoardRoom => ({
  boardId: row.board_id,
  roomId: row.room_id,
  alias: row.alias,
  encrypted: row.encrypted === 1,
  createdAt: row.created_at,
});

function userVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

/** Apply every migration the database has not seen, each in its own transaction. */
export function migrate(
  db: Database,
  migrations: readonly string[] = MIGRATIONS,
): void {
  const at = userVersion(db);
  if (at > migrations.length) {
    throw new StoreError(
      `the database is at schema version ${at}, newer than this build's ${migrations.length}`,
    );
  }
  for (let version = at + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1] as string;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
  }
}
