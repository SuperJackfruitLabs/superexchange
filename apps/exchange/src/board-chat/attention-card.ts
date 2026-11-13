/**
 * Posting a delivered waiting card into its board's room, exactly once per wait, and its receipt.
 *
 * Ported from the AgentPod hub's `services/board-chat/attention-projection.ts`
 * (`projectAttention`) and `attention-answer.ts` (`settleAttentionOutcome`). A waiting card is ONE
 * event, built only by treaty: `attentionV2Content`, an `m.room.message` carrying
 * `dev.superpipeline.attention.v2`, saying what is wrong and offering only what chat may do about
 * it (resume here, resume at an earlier stage, archive). What it offers is recorded with the claim,
 * because an answer is judged against that and nothing else. The post itself is `card-post.ts`:
 * held until a person has joined, fail closed on encryption, claimed before the send, one
 * transaction id on every try.
 *
 * A card posted long after it was raised (the sweep finding a wait from before the board was opted
 * in, a held card nobody joined to read) says so: its summary leads with when it was raised and how
 * long before the post that was (`attentionCardContent`), so the agent's words and the failure
 * count read as of then, not as news.
 *
 * Its receipt is a prose line in reply to the card's message, and
 * `dev.superpipeline.attention.outcome.v1` pointing at it (`attentionOutcomeContent`). The outcome
 * is what an updated client closes the card by; the reply is what ties the line to its card in any
 * client. One per wait: the answer path claims it (`claimAttentionReceipt`) and the sweep claims it
 * (`settleAttentionEvent`) on the same column.
 *
 * Not ported: the hub's fleet Live Activity (`onAttentionPosted`), which is AgentPod's.
 */
import {
  ATTENTION_OUTCOME_TYPE,
  SETTLED_ELSEWHERE,
  attentionAction,
  attentionOptionsV2,
  attentionOutcomeContent,
  attentionV2Content,
  isAttentionPending,
  type AttentionPendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type {
  AttentionEvent,
  CardOfferOption,
  Store,
  WaitKey,
} from "../store/index.ts";
import { waitKeyOf } from "./attention.ts";
import {
  postCard,
  type CardPostDeps,
  type CardPostOutcome,
} from "./card-post.ts";
import type { RoomSender } from "./room-sender.ts";
import { describe } from "./rooms.ts";

/**
 * The transaction id a waiting card's event is sent under: the same on every try. The wait is
 * hashed, so ids that contain a separator can never make two waits share one.
 */
export function attentionTxnId(
  key: WaitKey,
  part: "prose" | "outcome.prose" | "outcome.card",
): string {
  const wait = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([key.boardId, key.cardId, key.waitId]))
    .digest("hex")
    .slice(0, 32);
  return `superexchange.attention.${wait}.${part}`;
}

/** How a log names a wait: its card and wait ids, never its content. */
export function waitLabel(key: WaitKey): string {
  return `waiting card ${JSON.stringify(key.cardId)} (wait ${JSON.stringify(key.waitId)})`;
}

/** What a waiting card offers, exactly as its attention.v2 carries it. */
export function attentionOffer(
  d: Parameters<typeof attentionOptionsV2>[0],
): CardOfferOption[] {
  return attentionOptionsV2(d).map((o) => ({
    id: o.id,
    label: o.label,
    ...(o.input
      ? {
          input: {
            kind: o.input.kind,
            required: o.input.required,
            max_length: o.input.max_length,
          },
        }
      : {}),
  }));
}

/** A waiting card raised at least this long before it is posted says when it was raised. */
export const RAISED_LINE_AFTER_MS = 60 * 60 * 1000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const two = (n: number) => String(n).padStart(2, "0");

/** How long before the post, in words: hours below two days, then days. */
function ageWords(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * The sentence a waiting card leads with when it was raised an hour or more before `postedAt`:
 * "Raised 6 Nov, 06:32 UTC, 7 days before this card was posted; what it says is as of then." Null
 * when the raise is recent, unknown (`ts` absent or unreadable) or after the post. The time is UTC,
 * said as UTC: the service does not know the reader's zone.
 */
export function raisedLine(ts: unknown, postedAt: Date): string | null {
  if (typeof ts !== "string") return null;
  const raised = Date.parse(ts);
  if (!Number.isFinite(raised)) return null;
  const age = postedAt.getTime() - raised;
  if (!(age >= RAISED_LINE_AFTER_MS)) return null;
  const at = new Date(raised);
  const year =
    at.getUTCFullYear() === postedAt.getUTCFullYear()
      ? ""
      : ` ${at.getUTCFullYear()}`;
  const when = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
  return `Raised ${when}, ${ageWords(age)} before this card was posted; what it says is as of then.`;
}

/**
 * A waiting card's message as posted at `postedAt`: treaty's attention.v2, its summary led by
 * `raisedLine` when the card was raised an hour or more before. Built by treaty either way; only
 * the summary it is given differs, so the prose and the client's summary field both say it.
 */
export function attentionCardContent(
  d: AttentionPendingDelivery,
  postedAt: Date,
): Record<string, unknown> {
  const raised = raisedLine(d.ts, postedAt);
  if (raised === null) return attentionV2Content(d);
  const said =
    typeof d.summary === "string" && d.summary.trim() !== ""
      ? `${raised} ${d.summary}`
      : raised;
  return attentionV2Content({ ...d, summary: said });
}

export type AttentionPostOutcome =
  | CardPostOutcome
  | {
      status: "skipped";
      reason:
        | "not delivered"
        | "settled"
        | "not a waiting card"
        | "board not opted in"
        | "board disabled";
    };

export interface AttentionPostDeps extends Omit<CardPostDeps, "store"> {
  store: Pick<
    Store,
    | "getBoard"
    | "attentionDelivery"
    | "attentionEvent"
    | "claimAttentionEvent"
    | "recordAttentionPosted"
    | "boardRoom"
    | "boardRoomByRoomId"
  >;
  /** The clock a card's age is read against when it is posted. */
  now?: () => Date;
}

/** Post one delivered waiting card. Run only in board chat's queue. */
export async function postAttention(
  deps: AttentionPostDeps,
  key: WaitKey,
): Promise<AttentionPostOutcome> {
  const { store } = deps;
  const delivery = store.attentionDelivery(key);
  if (delivery === null) return { status: "skipped", reason: "not delivered" };
  // The wait ended before it was posted: never posted after.
  if (delivery.settledAt !== null)
    return { status: "skipped", reason: "settled" };
  const d = delivery.body;
  if (!isAttentionPending(d))
    return { status: "skipped", reason: "not a waiting card" };
  const board = store.getBoard(d.boardId);
  if (board === null)
    return { status: "skipped", reason: "board not opted in" };
  if (!board.enabled) return { status: "skipped", reason: "board disabled" };
  const wait = waitKeyOf(d);
  return postCard(deps, {
    at: waitLabel(wait),
    heldKey: `attention\u0000${attentionTxnId(wait, "prose")}`,
    board,
    boardName: d.boardName ?? null,
    claimed: () => store.attentionEvent(wait),
    claim: (roomId) =>
      store.claimAttentionEvent(wait, roomId, attentionOffer(d)),
    recordPosted: (eventId) => store.recordAttentionPosted(wait, eventId),
    txnId: attentionTxnId(wait, "prose"),
    content: () => attentionCardContent(d, (deps.now ?? (() => new Date()))()),
  });
}

/** The prose line of a waiting card's receipt (the hub's `receiptWords`). */
export function attentionReceiptBody(
  decision: string,
  options: ReadonlyArray<{ id: string; label: string }>,
  decidedBy: string | null,
): string {
  let what = "Resumed";
  if (decision === SETTLED_ELSEWHERE)
    what = "This card is no longer waiting — it was settled on the board";
  else {
    const action = attentionAction(decision);
    if (action?.kind === "archive") what = "Archived";
    else if (action?.kind === "resume" && action.toStageKey !== null) {
      const label = options.find((o) => o.id === decision)?.label;
      what = label ? `Resumed (${label})` : `Resumed at ${action.toStageKey}`;
    }
  }
  return decidedBy ? `${what} by ${decidedBy} — the board has it.` : `${what}.`;
}

/**
 * Send a waiting card's receipt, already claimed: the prose line in reply to the card's message
 * (unless `prose` is false), then `attention.outcome.v1` at that message, each under its own
 * transaction id.
 */
export async function sendAttentionReceipt(
  sender: Pick<RoomSender, "sendEvent">,
  speaker: string,
  card: Pick<
    AttentionEvent,
    "boardId" | "cardId" | "waitId" | "roomId" | "eventId" | "options"
  >,
  decision: string,
  decidedBy: string | null,
  { prose = true }: { prose?: boolean } = {},
): Promise<void> {
  if (prose) {
    await sender.sendEvent(
      speaker,
      card.roomId,
      "m.room.message",
      attentionTxnId(card, "outcome.prose"),
      {
        msgtype: "m.text",
        body: attentionReceiptBody(decision, card.options, decidedBy),
        ...(card.eventId
          ? { "m.relates_to": { "m.in_reply_to": { event_id: card.eventId } } }
          : {}),
      },
    );
  }
  await sender.sendEvent(
    speaker,
    card.roomId,
    ATTENTION_OUTCOME_TYPE,
    attentionTxnId(card, "outcome.card"),
    attentionOutcomeContent(
      {
        boardId: card.boardId,
        cardId: card.cardId,
        waitId: card.waitId,
        eventId: card.eventId ?? "",
      },
      decision,
      decidedBy,
    ),
  );
}

/**
 * What closing a waiting card whose wait ended elsewhere came to: `settled`, `withdrawn` (never
 * posted, and now never will be), `already`, `refused` (its room may not be spoken in), `unknown`.
 */
export type AttentionSettleOutcome =
  | "settled"
  | "withdrawn"
  | "already"
  | "refused"
  | "unknown";

export interface AttentionSettleDeps {
  store: Pick<
    Store,
    | "attentionDelivery"
    | "attentionEvent"
    | "settleAttentionDelivery"
    | "settleAttentionEvent"
    | "boardRoomByRoomId"
  >;
  sender: Pick<RoomSender, "sendEvent" | "refusal">;
  speaker: string;
  log: (line: string) => void;
}

/**
 * Close a waiting card the board no longer lists under that wait (resumed, archived or moved on the
 * board, or waiting on something else now): its receipt once, naming nobody, if it is in a room;
 * never posted if it is not. Run only in board chat's queue.
 */
export async function settleAttention(
  deps: AttentionSettleDeps,
  key: WaitKey,
): Promise<AttentionSettleOutcome> {
  const { store } = deps;
  const delivery = store.attentionDelivery(key);
  const card = store.attentionEvent(key);
  if (delivery === null && card === null) return "unknown";
  store.settleAttentionDelivery(key);
  if (card === null || card.postedAt === null) return "withdrawn";
  const room = store.boardRoomByRoomId(card.roomId);
  if (room === null || deps.sender.refusal(room) !== null) return "refused";
  if (!store.settleAttentionEvent(key)) return "already";
  try {
    await sendAttentionReceipt(
      deps.sender,
      deps.speaker,
      card,
      SETTLED_ELSEWHERE,
      null,
    );
  } catch (error) {
    deps.log(
      `board-chat: ${waitLabel(key)} is settled on the board, and its receipt could not be posted (${describe(error)})`,
    );
  }
  return "settled";
}
