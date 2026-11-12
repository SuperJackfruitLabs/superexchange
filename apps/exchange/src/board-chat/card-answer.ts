/**
 * What the answer to a single-event card (a delivery follow-up, a waiting card) shares with every
 * other answer here, before the card's own rules: a message in a board room this service owns,
 * from outside its own namespace; the sender's principal, from the organization plane; and only a
 * person may answer (a follow-up is a person's answer, like the gate it follows; an agent
 * unblocking a card is exactly what a waiting card exists to deny).
 *
 * Silent, as the hub is, for anything that is not plainly a person's answer here: this service's
 * own namespace, a room it does not own, an unlinked sender, a principal that is not a person
 * (logged, so somebody sees it). Said in the room: the plane unreachable.
 */
import type { AppserviceClient, MatrixEvent } from "../appservice/index.ts";
import type { Store } from "../store/index.ts";
import {
  AccountsError,
  type Accounts,
  type SenderPrincipal,
} from "./accounts.ts";
import { IDENTITY_UNAVAILABLE_TEXT } from "./gate-answer.ts";
import {
  NAMESPACE_USER_PREFIX,
  describe as describeClientError,
} from "./rooms.ts";

/** Text past this is refused before anything else: no link or instruction the board takes is longer. */
export const TEXT_READ_MAX = 16_000;

export type CardAnswerIgnored =
  | "not-an-answer"
  | "own-namespace"
  | "not-a-board-room"
  | "unknown-card"
  | "reference-mismatch"
  | "board-disabled"
  | "already-answered"
  | "unlinked-sender"
  | "not-human";

/** The board's refusals every card shares, in words (the hub's `boardRefusalText`). */
export function boardRefusalText(code: string): string {
  if (code === "IDENTITY_UNAVAILABLE") return IDENTITY_UNAVAILABLE_TEXT;
  if (code === "ASSERTION_REFUSED" || code === "ASSERTION_MISMATCH")
    return `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`;
  return `That did not go through (${code}). Nothing has changed.`;
}

export interface CardAnswerDeps {
  store: Pick<Store, "boardRoomByRoomId">;
  client: Pick<AppserviceClient, "sendEvent">;
  speaker: string;
  accounts: Pick<Accounts, "principalForMatrixId">;
  log: (line: string) => void;
}

/** A person's message in a board room this service owns, or why it is not one. */
export function inBoardRoom(
  store: Pick<Store, "boardRoomByRoomId">,
  event: MatrixEvent,
): { sender: string; roomId: string } | { ignored: CardAnswerIgnored } {
  const { sender, room_id: roomId } = event;
  if (typeof sender !== "string" || typeof roomId !== "string")
    return { ignored: "not-an-answer" };
  if (sender.startsWith(NAMESPACE_USER_PREFIX))
    return { ignored: "own-namespace" };
  if (store.boardRoomByRoomId(roomId) === null)
    return { ignored: "not-a-board-room" };
  return { sender, roomId };
}

/** A reply to an answer, under its event's id: a redelivered answer says it once. */
export function replier(
  deps: Pick<CardAnswerDeps, "client" | "speaker">,
  kind: string,
  event: MatrixEvent,
  roomId: string,
): (body: string) => Promise<unknown> {
  return (body) =>
    deps.client.sendEvent(
      deps.speaker,
      roomId,
      "m.room.message",
      `superexchange.${kind}.reply.${event.event_id ?? crypto.randomUUID()}`,
      { msgtype: "m.text", body },
    );
}

/**
 * The sender, when they are a person who may answer; else what to return: silent for an unlinked
 * sender or one who is not a person, said in the room when the plane cannot be asked.
 */
export async function personFor(
  deps: CardAnswerDeps,
  sender: string,
  at: string,
  reply: (body: string) => Promise<unknown>,
): Promise<
  | SenderPrincipal
  | { ignored: "unlinked-sender" | "not-human" }
  | { refused: "identity-unavailable" }
> {
  let principal: SenderPrincipal | null;
  try {
    principal = await deps.accounts.principalForMatrixId(sender);
  } catch (error) {
    deps.log(
      `board-chat: an answer to ${at}: the sender could not be looked up (${describe(error)})`,
    );
    await reply(IDENTITY_UNAVAILABLE_TEXT);
    return { refused: "identity-unavailable" };
  }
  if (principal === null) {
    deps.log(`board-chat: an answer to ${at} from an unlinked sender; ignored`);
    return { ignored: "unlinked-sender" };
  }
  if (principal.kind !== "human") {
    deps.log(
      `board-chat: a ${JSON.stringify(principal.kind.slice(0, 20))} principal tried to answer ${at}; refused`,
    );
    return { ignored: "not-human" };
  }
  return principal;
}

/** An error as a log may carry it: a plane or homeserver error's status and code only. */
export function describe(error: unknown): string {
  if (error instanceof AccountsError) return error.message;
  return describeClientError(error);
}
