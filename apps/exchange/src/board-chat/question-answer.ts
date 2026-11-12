/**
 * The way back for a board question: a person's answer becomes an answer at SuperPipeline, as
 * that person, and one receipt says the board took it.
 *
 * Ported from the AgentPod hub's `services/board-chat/question-answer.ts` (`handleQuestionAnswer`),
 * `elicitations.ts` (`handleElicitationAnswer`, `reportAnswer`), `reply-options.ts` and the
 * routing in `matrix-as/inbound.ts`. Parsing is treaty's (`parseQuestionAnswer`, `inputRefusal`,
 * `subjectRefusal`); judging an answer against what was posted, and acting on it, are this
 * service's. Two ways in:
 *
 * - **question.answer.v2**: a message naming its question and an `m.reference` to the message
 *   that asked it, judged against what was RECORDED when the question was posted
 *   (`question_events`): an option it offered, with the input it asks for, bound to the subject it
 *   showed. Both identifiers are checked against each other, and the room.
 * - **a typed reply**: an ordinary `m.text` in a board room, a number, an option's label or id,
 *   matched against the question open in that room (the newest posted one without a receipt, an
 *   agent's question before an approval request). That is what makes a question answerable from
 *   any Matrix client. Nothing is guessed: a reply that is not plainly an option is given the list
 *   again, and only to a linked person.
 *
 * It fails closed at every step, as a gate answer does. Silent, as the hub is, for: not an answer,
 * this service's own namespace, a room it does not own, a question it never posted there, a
 * reference to another message, a board no longer opted in, an unlinked sender, and a non-person
 * answering an approval request (charter: "Waiting cards and broker approvals reach chat" §5).
 * Said in the room: the plane unreachable, an answer the question did not offer, a subject-bound
 * question approved by typing or without its binding, and every refusal the board gives back.
 *
 * An approval request whose subject was never carried is never allowed from a room: only a
 * decline goes on. A question with a receipt never reaches the board again. The receipt is one
 * line, claimed before it is sent, under the same claim the sweep's closing line takes.
 */
import {
  inputRefusal,
  parseQuestionAnswer,
  subjectRefusal,
  SUBJECT_REFUSAL_TEXT,
  type ParsedQuestionAnswer,
  type SubjectRefusal,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { AppserviceClient, MatrixEvent } from "../appservice/index.ts";
import type {
  QuestionEvent,
  QuestionOfferSubject,
  Store,
} from "../store/index.ts";
import {
  AccountsError,
  type Accounts,
  type SenderPrincipal,
} from "./accounts.ts";
import { IDENTITY_UNAVAILABLE_TEXT } from "./gate-answer.ts";
import { questionTxnId } from "./question-card.ts";
import {
  NAMESPACE_USER_PREFIX,
  describe as describeClientError,
} from "./rooms.ts";
import type { QuestionAnswerInput, ResolveResult } from "./superpipeline.ts";

/** Text past this is refused whatever the question allows: no option or question takes more. */
const TEXT_READ_MAX = 16_000;

/** Said when an approval request whose subject was never carried is asked to allow. */
export const APPROVAL_UNBOUND_TEXT =
  "This request could not be shown here, so it cannot be allowed from this room. Nothing has changed.";

/** Said when a typed reply (or a v1 card's button) tries to approve a subject-bound question. */
export const TYPED_APPROVAL_REFUSED_TEXT =
  "This approves an exact operation that a typed reply can't show you. Open it in an updated app or on the board to approve it. Nothing has changed.";

/** Said once when the board says the question is over. */
export const ALREADY_SETTLED_TEXT =
  "That one is already settled — the board has it.";

const REFUSAL_TEXT = {
  "bad-option":
    "That is not one of this question's options. Nothing has changed.",
  "input-required": "That answer needs some text. Nothing has changed.",
  "url-invalid": "That answer needs an https:// link. Nothing has changed.",
} as const;

/** The board's refusals of a binding or an approval request, in words. */
const BOARD_TEXT: Record<string, string> = {
  APPROVAL_SUBJECT_MISMATCH:
    "The board says that answer was for a different version of this decision. Open the latest one and answer again. Nothing has changed.",
  DECISION_EXPIRED:
    "The board says this decision has expired, so it can no longer be answered. Nothing has changed.",
  WORKSPACE_ADMIN_REQUIRED:
    "Only workspace owners and admins can allow this. Nothing has changed.",
  SEPARATION_OF_DUTIES:
    "Whoever made a request can't also decide it. Someone else has to answer. Nothing has changed.",
};

export type QuestionAnswerIgnored =
  | "not-an-answer"
  | "own-namespace"
  | "not-a-board-room"
  | "unknown-question"
  | "reference-mismatch"
  | "board-disabled"
  | "no-question"
  | "already-answered";

export type QuestionAnswerRefusal =
  | "identity-unavailable"
  | "unlinked-sender"
  | "not-human"
  | "bad-option"
  | "input-required"
  | "text-too-long"
  | "url-invalid"
  | SubjectRefusal
  | "approval-unbound"
  | "typed-approval"
  | "unmatched"
  | "board-refused";

export type QuestionAnswerOutcome =
  | { status: "ignored"; reason: QuestionAnswerIgnored }
  | { status: "refused"; reason: QuestionAnswerRefusal; code?: string }
  | { status: "answered"; elicitationId: string };

export interface QuestionAnswersDeps {
  store: Pick<
    Store,
    | "boardRoomByRoomId"
    | "getBoard"
    | "questionEvent"
    | "openQuestionsInRoom"
    | "claimQuestionReceipt"
  >;
  client: Pick<AppserviceClient, "sendEvent">;
  speaker: string;
  accounts: Pick<Accounts, "principalForMatrixId">;
  /** Answer at SuperPipeline as the person (`answerQuestionAtSuperpipeline`). */
  answerQuestion(input: QuestionAnswerInput): Promise<ResolveResult>;
  log: (line: string) => void;
  now?: () => Date;
}

export interface QuestionAnswers {
  /** A question.answer.v2, by treaty's parse? */
  isAnswer(event: MatrixEvent): boolean;
  /**
   * Could this be a typed reply: an `m.text` with words, carrying no structured envelope (any
   * `suite_event_type`: another product's answer is never read as a number)?
   */
  isTypedReply(event: MatrixEvent): boolean;
  handle(event: MatrixEvent): Promise<QuestionAnswerOutcome>;
  handleTyped(event: MatrixEvent): Promise<QuestionAnswerOutcome>;
}

type Verdict =
  | {
      option?: string;
      text?: string;
      subject?: { id: string; digest: string };
      label: string | null;
    }
  | {
      refusal:
        | "bad-option"
        | "input-required"
        | "text-too-long"
        | "url-invalid"
        | "approval-unbound"
        | SubjectRefusal;
      limit?: number;
    };

export function createQuestionAnswers(
  deps: QuestionAnswersDeps,
): QuestionAnswers {
  const { store, log } = deps;
  const now = deps.now ?? (() => new Date());

  /** Each reply to an answer goes under its event's id: a redelivered answer says it once. */
  const replyTo = (event: MatrixEvent, roomId: string) => (body: string) =>
    deps.client.sendEvent(
      deps.speaker,
      roomId,
      "m.room.message",
      `superexchange.question.reply.${event.event_id ?? crypto.randomUUID()}`,
      { msgtype: "m.text", body },
    );

  /** The checks every way in shares: a person's message in a board room this service owns. */
  function inBoardRoom(
    event: MatrixEvent,
  ): { sender: string; roomId: string } | { ignored: QuestionAnswerIgnored } {
    const { sender, room_id: roomId } = event;
    if (typeof sender !== "string" || typeof roomId !== "string")
      return { ignored: "not-an-answer" };
    if (sender.startsWith(NAMESPACE_USER_PREFIX))
      return { ignored: "own-namespace" };
    if (store.boardRoomByRoomId(roomId) === null)
      return { ignored: "not-a-board-room" };
    return { sender, roomId };
  }

  function boardEnabled(q: QuestionEvent): boolean {
    const board = store.getBoard(q.boardId);
    return board !== null && board.enabled;
  }

  /** The sender's principal; null after saying (or not) why there is none to act for. */
  async function principalOf(
    sender: string,
    at: string,
    reply: (body: string) => Promise<unknown>,
  ): Promise<SenderPrincipal | QuestionAnswerOutcome> {
    try {
      const principal = await deps.accounts.principalForMatrixId(sender);
      if (principal === null) {
        log(`board-chat: an answer to ${at} from an unlinked sender; ignored`);
        return refused("unlinked-sender");
      }
      return principal;
    } catch (error) {
      log(
        `board-chat: an answer to ${at}: the sender could not be looked up (${describe(error)})`,
      );
      await reply(IDENTITY_UNAVAILABLE_TEXT);
      return refused("identity-unavailable");
    }
  }

  /** Say what the board did with an answer, the same words for both ways in. */
  async function report(
    result: ResolveResult,
    q: QuestionEvent,
    answered: string | null,
    reply: (body: string) => Promise<unknown>,
  ): Promise<QuestionAnswerOutcome> {
    const at = `question ${JSON.stringify(q.elicitationId)}`;
    const receipt = (body: string) =>
      deps.client.sendEvent(
        deps.speaker,
        q.roomId,
        "m.room.message",
        questionTxnId(q.elicitationId, "outcome"),
        { msgtype: "m.text", body },
      );
    if (!result.ok) {
      log(
        `board-chat: the board did not take an answer to ${at} (${result.code.slice(0, 64)})`,
      );
      if (
        result.code === "ELICITATION_NOT_PENDING" ||
        result.code === "ELICITATION_NOT_FOUND"
      ) {
        // Answered on the board, or retired by a newer question: said once, under the receipt's
        // claim, so a double tap leaves one line.
        if (store.claimQuestionReceipt(q.elicitationId))
          await receipt(ALREADY_SETTLED_TEXT);
        return refused("board-refused", result.code);
      }
      await reply(
        result.code === "IDENTITY_UNAVAILABLE"
          ? IDENTITY_UNAVAILABLE_TEXT
          : (BOARD_TEXT[result.code] ??
              `That did not go through (${result.code.slice(0, 64)}). Nothing has changed.`),
      );
      return refused("board-refused", result.code);
    }
    log(`board-chat: ${at} answered from chat on ${q.boardId}`);
    if (store.claimQuestionReceipt(q.elicitationId)) {
      const tail = q.offer.approvalRequest
        ? "SuperToolkit has the decision."
        : "The agent is unblocked.";
      try {
        await receipt(
          answered ? `Answered: ${answered}. ${tail}` : `Answered. ${tail}`,
        );
      } catch (error) {
        // Answered by now: a receipt that cannot be posted must not turn it into a failure.
        log(
          `board-chat: ${at} answered, and its receipt could not be posted (${describe(error)})`,
        );
      }
    }
    return { status: "answered", elicitationId: q.elicitationId };
  }

  async function handle(event: MatrixEvent): Promise<QuestionAnswerOutcome> {
    if (event.type !== "m.room.message") return ignored("not-an-answer");
    const parsed = parseQuestionAnswer(event.content);
    if (parsed === null) return ignored("not-an-answer");
    const where = inBoardRoom(event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;

    const at = `question ${JSON.stringify(parsed.elicitationId.slice(0, 200))}`;
    const q = store.questionEvent(parsed.elicitationId);
    if (q === null || q.eventId === null) {
      log(`board-chat: an answer names ${at}, which was not posted; ignored`);
      return ignored("unknown-question");
    }
    // Both the id and the reference, checked against each other, and the room: an answer sent
    // elsewhere cannot reach a question by naming its message.
    if (parsed.referencedEventId !== q.eventId || roomId !== q.roomId) {
      log(
        `board-chat: an answer to ${at} references another event or room; ignored`,
      );
      return ignored("reference-mismatch");
    }
    if (!boardEnabled(q)) return ignored("board-disabled");
    if (q.outcomePostedAt !== null) return ignored("already-answered");

    const reply = replyTo(event, roomId);
    const principal = await principalOf(sender, at, reply);
    if ("status" in principal) return principal;
    if (q.offer.approvalRequest && principal.kind !== "human") {
      // Only a person's answer to an approval request is carried, not even a bound deny.
      log(
        `board-chat: a ${JSON.stringify(principal.kind.slice(0, 20))} principal tried to answer approval request ${at}; refused`,
      );
      return refused("not-human");
    }

    const verdict = judge(parsed, q, now());
    if ("refusal" in verdict) {
      log(
        `board-chat: an answer to ${at} refused before the board (${verdict.refusal})`,
      );
      await reply(
        verdict.refusal === "text-too-long"
          ? `That answer is longer than this question takes (at most ${verdict.limit ?? 0} characters). Nothing has changed.`
          : refusalText(verdict.refusal),
      );
      return refused(verdict.refusal);
    }

    const result = await deps.answerQuestion({
      boardId: q.boardId,
      elicitationId: q.elicitationId,
      ...(verdict.option !== undefined ? { option: verdict.option } : {}),
      ...(verdict.text !== undefined ? { text: verdict.text } : {}),
      ...(verdict.subject ? { subject: verdict.subject } : {}),
      principalId: principal.id,
      senderMxid: sender,
    });
    return report(result, q, verdict.label, reply);
  }

  async function handleTyped(
    event: MatrixEvent,
  ): Promise<QuestionAnswerOutcome> {
    if (!isTypedReply(event)) return ignored("not-an-answer");
    const where = inBoardRoom(event);
    if ("ignored" in where) return ignored(where.ignored);
    const { sender, roomId } = where;
    const body = (event.content as { body: string }).body;

    const open = store.openQuestionsInRoom(roomId);
    // A typed reply is meant for an agent's question whenever one is open: an approval request
    // posted after it must not capture the "2" its asker was waiting for.
    const q = open.find((o) => !o.offer.approvalRequest) ?? open[0];
    if (!q) return ignored("no-question");
    if (!boardEnabled(q)) return ignored("board-disabled");
    // Buttons only: the prose already said to answer this one on the board.
    if (q.offer.options.length === 0) return ignored("not-an-answer");

    const at = `question ${JSON.stringify(q.elicitationId)}`;
    const reply = replyTo(event, roomId);
    const matched = matchReply(body, q.offer.options);
    if (matched === null) {
      // Ordinary talk in the room is not an error; the list goes back only to a linked person,
      // so a stranger or an agent cannot make this service speak.
      let principal: SenderPrincipal | null = null;
      try {
        principal = await deps.accounts.principalForMatrixId(sender);
      } catch {
        principal = null;
      }
      if (principal?.kind !== "human") return refused("unmatched");
      await reply(unmatchedText(q.offer.options));
      return refused("unmatched");
    }

    const principal = await principalOf(sender, at, reply);
    if ("status" in principal) return principal;
    if (q.offer.approvalRequest && principal.kind !== "human") {
      log(
        `board-chat: a ${JSON.stringify(principal.kind.slice(0, 20))} principal tried to answer approval request ${at}; refused`,
      );
      return refused("not-human");
    }
    const meaning = q.offer.optionsV2.find((o) => o.id === matched)?.meaning;
    if (q.offer.approvalRequest && !q.offer.subject && meaning !== "reject") {
      await reply(APPROVAL_UNBOUND_TEXT);
      return refused("approval-unbound");
    }

    // A subject-bound question is never approved by typing: the person typed against prose that
    // does not show what is approved. Anything else goes bound to the version recorded when the
    // question was posted, so a decline of a since-replaced version is refused by the board.
    let subject: { id: string; digest: string } | undefined;
    if (q.offer.subject) {
      if (meaning === undefined || meaning === "approve") {
        log(
          `board-chat: a typed reply tried to approve subject-bound ${at}; refused`,
        );
        await reply(TYPED_APPROVAL_REFUSED_TEXT);
        return refused("typed-approval");
      }
      subject = { id: q.offer.subject.id, digest: q.offer.subject.digest };
      const why = subjectRefusal(
        recorded(q.offer.subject),
        subject,
        meaning,
        now(),
      );
      if (why) {
        await reply(SUBJECT_REFUSAL_TEXT[why]);
        return refused(why);
      }
    }

    const result = await deps.answerQuestion({
      boardId: q.boardId,
      elicitationId: q.elicitationId,
      option: matched,
      ...(subject ? { subject } : {}),
      principalId: principal.id,
      senderMxid: sender,
    });
    const label = q.offer.options.find((o) => o.id === matched)?.label;
    return report(result, q, label ?? matched, reply);
  }

  function isTypedReply(event: MatrixEvent): boolean {
    if (event.type !== "m.room.message") return false;
    const c = event.content;
    if (typeof c !== "object" || c === null) return false;
    const content = c as Record<string, unknown>;
    if ("suite_event_type" in content) return false;
    return (
      content.msgtype === "m.text" &&
      typeof content.body === "string" &&
      content.body.trim() !== ""
    );
  }

  return {
    isAnswer: (event) =>
      event.type === "m.room.message" &&
      parseQuestionAnswer(event.content) !== null,
    isTypedReply,
    handle,
    handleTyped,
  };
}

const ignored = (reason: QuestionAnswerIgnored): QuestionAnswerOutcome => ({
  status: "ignored",
  reason,
});

const refused = (
  reason: QuestionAnswerRefusal,
  code?: string,
): QuestionAnswerOutcome => ({
  status: "refused",
  reason,
  ...(code !== undefined ? { code: code.slice(0, 64) } : {}),
});

/** The subject as treaty's `subjectRefusal` reads it. */
function recorded(s: QuestionOfferSubject) {
  return {
    id: s.id,
    digest: s.digest,
    previewComplete: s.previewComplete,
    expiresAt: s.expiresAt === null ? null : new Date(s.expiresAt),
  };
}

/**
 * What the answer passes to the board, or why it must not: against what THIS question offered
 * when it was posted, and on a question bound to a subject, against the binding recorded then.
 */
function judge(
  parsed: ParsedQuestionAnswer,
  q: QuestionEvent,
  now: Date,
): Verdict {
  const verdict = judgeOption(parsed, q);
  if ("refusal" in verdict) return verdict;
  const meaning = q.offer.optionsV2.find(
    (o) => o.id === verdict.option,
  )?.meaning;
  if (!q.offer.subject) {
    // An approval request with no recorded subject is never approved from here: only a decline.
    if (q.offer.approvalRequest && meaning !== "reject")
      return { refusal: "approval-unbound" };
    return verdict;
  }
  const why = subjectRefusal(
    recorded(q.offer.subject),
    parsed.subject ?? null,
    meaning,
    now,
  );
  if (why) return { refusal: why };
  return {
    ...verdict,
    subject: { id: q.offer.subject.id, digest: q.offer.subject.digest },
  };
}

function judgeOption(parsed: ParsedQuestionAnswer, q: QuestionEvent): Verdict {
  if (parsed.text !== null && parsed.text.length > TEXT_READ_MAX)
    return { refusal: "text-too-long", limit: TEXT_READ_MAX };
  if (parsed.optionId === null) {
    // Text alone answers only a question with nothing to choose.
    if (q.offer.freeTextMaxLength === null) return { refusal: "bad-option" };
    const why = inputRefusal(
      { kind: "text", required: true, max_length: q.offer.freeTextMaxLength },
      parsed.text,
    );
    if (why) return { refusal: why, limit: q.offer.freeTextMaxLength };
    return { text: parsed.text ?? "", label: null };
  }
  const option = q.offer.optionsV2.find((o) => o.id === parsed.optionId);
  if (!option) return { refusal: "bad-option" };
  if (!option.input) return { option: option.id, label: option.label };
  const why = inputRefusal(option.input, parsed.text);
  if (why) return { refusal: why, limit: option.input.max_length };
  return {
    option: option.id,
    ...(parsed.text !== null ? { text: parsed.text } : {}),
    label: option.label,
  };
}

function refusalText(
  r:
    | "bad-option"
    | "input-required"
    | "url-invalid"
    | "approval-unbound"
    | SubjectRefusal,
): string {
  if (r === "approval-unbound") return APPROVAL_UNBOUND_TEXT;
  if (r === "bad-option" || r === "input-required" || r === "url-invalid")
    return REFUSAL_TEXT[r];
  return SUBJECT_REFUSAL_TEXT[r];
}

/**
 * The option a typed reply selects, or null (the hub's `matchPermissionAnswer`): its number as
 * listed (1-based), its label, or its id, ignoring case and surrounding space. Nothing else,
 * including anything that merely resembles agreement.
 */
export function matchReply(
  reply: string,
  options: ReadonlyArray<{ id: string; label: string }>,
): string | null {
  const text = reply.trim().toLowerCase();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return options[Number(text) - 1]?.id ?? null;
  const byLabel = options.find((o) => o.label.trim().toLowerCase() === text);
  if (byLabel) return byLabel.id;
  return options.find((o) => o.id.trim().toLowerCase() === text)?.id ?? null;
}

/** The options again, not a scolding (the hub's `unmatchedAnswerText`). */
export function unmatchedText(
  options: ReadonlyArray<{ id: string; label: string }>,
): string {
  return [
    "That is not one of the options, so nothing has been approved.",
    "",
    options.map((o, i) => `${i + 1}. ${o.label}`).join("\n"),
    "",
    "Reply with the number, or the option's name.",
  ].join("\n");
}

/** An error as a log may carry it: a plane or homeserver error's status and code only. */
function describe(error: unknown): string {
  if (error instanceof AccountsError) return error.message;
  return describeClientError(error);
}
