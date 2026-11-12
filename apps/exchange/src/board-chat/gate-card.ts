/**
 * Posting a delivered gate into its board's room, exactly once.
 *
 * Ported from the AgentPod hub's `services/board-chat/gate-projection.ts`. A gate is two events,
 * built only by treaty:
 *
 * - the prose message (`m.room.message`): `gateV2Content`, the gate.v2 a person reads and a v2
 *   client answers, carrying the v1 card (`gateRequestCard`) under `GATE_REQUEST_CONTENT_KEY`;
 * - the custom card event (`GATE_EVENT_TYPE`, `gateEventContent`) that clients in the field still
 *   draw buttons from.
 *
 * Prose first, as the hub does: if only one lands, the room has a readable question rather than
 * buttons without context.
 *
 * The order of a post:
 *
 * 1. Fail closed on encryption. Board rooms are encrypted (charter) and this service cannot
 *    encrypt yet, so nothing is made or posted unless `SUPEREXCHANGE_PLAINTEXT_ROOMS` is on
 *    (staging only). The gate stays recorded and unposted; the refusal is logged once per board.
 * 2. The board's room, made once (`rooms.ts`).
 * 3. Held until a person has joined: no claim is taken, so the next join or boot posts it.
 * 4. The claim: a `gate_events` row inserted or ignored, before anything is sent. A gate that is
 *    already posted is never sent again.
 * 5. The sends, each under a transaction id derived from the gate, so a retry of a claimed,
 *    unfinished gate is answered by the homeserver with the first send's event rather than a
 *    second message. The prose's id is kept as soon as it lands, so a retry after the card failed
 *    sends only the card.
 *
 * Posts run one at a time, in arrival order, off the request that caused them: neither the relay
 * nor the homeserver's transaction waits on a post.
 */
import {
  GATE_EVENT_TYPE,
  GATE_REQUEST_CONTENT_KEY,
  gateEventContent,
  gateOptionsV2,
  gateRequestCard,
  gateSubjectV2,
  gateV2Content,
  gateVariantsV2,
  isGatePending,
  quorumV2,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type {
  AppserviceClient,
  EventsHandler,
  MatrixEvent,
} from "../appservice/index.ts";
import type { GateOffer, Store } from "../store/index.ts";
import type { AnswerOutcome, GateAnswers } from "./gate-answer.ts";
import { describe, type BoardRooms } from "./rooms.ts";

/** The event type of the prose message. */
const MESSAGE = "m.room.message";

/** The transaction id a gate's event is sent under: the same on every try. */
export function gateTxnId(
  gateId: string,
  part: "prose" | "card" | "outcome.prose" | "outcome.card",
): string {
  return `superexchange.gate.${gateId}.${part}`;
}

/**
 * What a gate offers, exactly as its gate.v2 carries it (the hub's `claimGate`): the options, the
 * subject an approval binds to, or the variants it offers a choice of, and its quorum. An answer
 * is checked against this record, never against a list.
 */
export function gateOffer(gate: GatePendingDelivery): GateOffer {
  const subject = gateSubjectV2(gate);
  const variants = gateVariantsV2(gate);
  return {
    options: gateOptionsV2(gate).map((o) => ({
      id: o.id,
      label: o.label,
      meaning: o.meaning,
      needs_comment: o.needs_comment,
    })),
    subjectId: subject?.id ?? null,
    subjectDigest: subject?.digest ?? null,
    subjectPreviewComplete: subject?.preview_complete ?? null,
    variants:
      variants?.map((v) => ({
        id: v.id,
        label: v.label,
        subject_id: v.subject.id,
        digest: v.subject.digest,
        preview_complete: v.subject.preview_complete,
        expires_at: v.subject.expires_at,
      })) ?? null,
    quorum: quorumV2(gate.quorum),
  };
}

export type PostOutcome =
  | {
      status: "posted";
      roomId: string;
      proseEventId: string;
      cardEventId: string;
    }
  | { status: "already" }
  | { status: "held"; roomId: string }
  | { status: "refused"; reason: "plaintext rooms off" }
  | {
      status: "skipped";
      reason:
        | "not delivered"
        | "not a gate"
        | "board not opted in"
        | "board disabled";
    }
  | { status: "failed"; step: "room" | "membership" | "send" };

export interface BoardChatDeps {
  store: Pick<
    Store,
    | "getBoard"
    | "gateDelivery"
    | "unpostedGates"
    | "boardRoomByRoomId"
    | "recordMembership"
    | "claimGateEvent"
    | "gateEvent"
    | "recordGateProse"
    | "recordGatePosted"
  >;
  client: Pick<AppserviceClient, "sendEvent">;
  rooms: BoardRooms;
  /** `SUPEREXCHANGE_PLAINTEXT_ROOMS`: off, nothing is made or posted. */
  plaintextRooms: boolean;
  /** People's answers to the gates posted here (`gate-answer.ts`); absent, none is read. */
  answers?: GateAnswers;
  log: (line: string) => void;
}

export interface BoardChat {
  /** Post one gate, queued behind every post before it. */
  post(gateId: string): Promise<PostOutcome>;
  /** A gate the relay accepted: queue its post and return at once. */
  gateAccepted(gateId: string): void;
  /** Every delivered gate not yet posted: queued at boot. */
  resume(): void;
  /**
   * The homeserver's events: a gate answer is queued to be carried to the board, before anything
   * else reads the event; memberships of board rooms are kept, and a person's join posts the held
   * gates.
   */
  onEvents: EventsHandler;
  /** Carry one answer, queued behind every post and answer before it. */
  answer(event: MatrixEvent): Promise<AnswerOutcome | null>;
  /** Settles when every queued post has run. */
  idle(): Promise<void>;
}

export function createBoardChat(deps: BoardChatDeps): BoardChat {
  const { store, client, rooms, log } = deps;
  const refusedBoards = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work);
    // The chain never rejects: one failed post must not stop the ones queued behind it.
    queue = run.catch(() => undefined);
    return run;
  }

  async function postOnce(gateId: string): Promise<PostOutcome> {
    const delivery = store.gateDelivery(gateId);
    if (delivery === null)
      return { status: "skipped", reason: "not delivered" };
    const gate = delivery.body;
    if (!isGatePending(gate))
      return { status: "skipped", reason: "not a gate" };
    const board = store.getBoard(gate.boardId);
    if (board === null)
      return { status: "skipped", reason: "board not opted in" };
    if (!board.enabled) return { status: "skipped", reason: "board disabled" };

    const claimed = store.gateEvent(gateId);
    if (claimed?.postedAt) return { status: "already" };

    if (!deps.plaintextRooms) {
      if (!refusedBoards.has(board.boardId)) {
        refusedBoards.add(board.boardId);
        log(
          `board-chat: ${board.boardId} has gates to post, and end-to-end encryption is not available yet: nothing is posted while SUPEREXCHANGE_PLAINTEXT_ROOMS is off`,
        );
      }
      return { status: "refused", reason: "plaintext rooms off" };
    }

    let roomId: string;
    if (claimed) {
      // Claimed by an earlier try that did not finish: it passed the hold then, and its room is
      // the one on the claim.
      roomId = claimed.roomId;
    } else {
      try {
        roomId = (await rooms.ensure(board, gate.boardName ?? undefined))
          .roomId;
      } catch (error) {
        log(
          `board-chat: gate ${JSON.stringify(gateId)} has no room on ${board.boardId} (${describe(error)})`,
        );
        return { status: "failed", step: "room" };
      }
      try {
        if (!(await rooms.personJoined(roomId))) {
          log(
            `board-chat: gate ${JSON.stringify(gateId)} held until a person joins the room of ${board.boardId}`,
          );
          return { status: "held", roomId };
        }
      } catch (error) {
        log(
          `board-chat: gate ${JSON.stringify(gateId)} held: the room's members could not be read (${describe(error)})`,
        );
        return { status: "failed", step: "membership" };
      }
      // The claim is the gate on the send, not a record of it: taken before anything is sent,
      // with what the gate offers, so an answer to it is checked against what was posted.
      store.claimGateEvent(gateId, board.boardId, roomId, gateOffer(gate));
    }

    const claim = store.gateEvent(gateId);
    if (claim === null) return { status: "failed", step: "send" };
    roomId = claim.roomId;

    try {
      let proseEventId = claim.proseEventId;
      if (proseEventId === null) {
        proseEventId = await client.sendEvent(
          rooms.speaker,
          roomId,
          MESSAGE,
          gateTxnId(gateId, "prose"),
          {
            ...gateV2Content(gate),
            [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(gate),
          },
        );
        store.recordGateProse(gateId, proseEventId);
      }
      const cardEventId = await client.sendEvent(
        rooms.speaker,
        roomId,
        GATE_EVENT_TYPE,
        gateTxnId(gateId, "card"),
        gateEventContent(gate),
      );
      store.recordGatePosted(gateId, cardEventId);
      log(
        `board-chat: gate ${JSON.stringify(gateId)} posted on ${board.boardId}`,
      );
      return { status: "posted", roomId, proseEventId, cardEventId };
    } catch (error) {
      // The claim stays: the next join or boot sends what is missing under the same ids.
      log(
        `board-chat: gate ${JSON.stringify(gateId)} not posted on ${board.boardId} (${describe(error)}); it is retried at the next join or boot`,
      );
      return { status: "failed", step: "send" };
    }
  }

  const post = (gateId: string) => enqueue(() => postOnce(gateId));
  const answers = deps.answers;
  // Answers share the posts' queue: an answer to a gate whose post is still running waits for it.
  const answer = (event: MatrixEvent) =>
    enqueue(async () => (answers ? answers.handle(event) : null)).catch(
      (error: unknown) => {
        log(
          `board-chat: a gate answer could not be carried (${describe(error)})`,
        );
        return null;
      },
    );
  const postAll = (boardId?: string) => {
    for (const gate of store.unpostedGates(boardId)) void post(gate.gateId);
  };

  return {
    post,
    gateAccepted: (gateId) => void post(gateId),
    answer,
    resume: () => {
      answers?.resume();
      postAll();
    },
    idle: () => queue.then(() => undefined),

    onEvents(_txnId, events) {
      const woken = new Set<string>();
      for (const event of events) {
        // A decision, before anything else: it answers the board, and nothing else may read it.
        if (answers?.isAnswer(event)) {
          void answer(event);
          continue;
        }
        const member = membershipOf(event);
        if (member === null) continue;
        const room = store.boardRoomByRoomId(member.roomId);
        if (room === null) continue;
        store.recordMembership(member.roomId, member.userId, member.membership);
        if (member.membership === "join" && rooms.isPerson(member.userId)) {
          woken.add(room.boardId);
        }
      }
      for (const boardId of woken) postAll(boardId);
    },
  };
}

/** The membership an `m.room.member` event states, or null when it is not one. */
function membershipOf(
  event: MatrixEvent,
): { roomId: string; userId: string; membership: string } | null {
  if (event.type !== "m.room.member") return null;
  const { room_id: roomId, state_key: userId, content } = event;
  if (typeof roomId !== "string" || typeof userId !== "string") return null;
  if (typeof content !== "object" || content === null) return null;
  const membership = (content as { membership?: unknown }).membership;
  if (typeof membership !== "string") return null;
  return { roomId, userId, membership };
}
