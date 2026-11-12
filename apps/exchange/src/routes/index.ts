/**
 * The service's HTTP surface, one dispatcher over:
 *
 * - `GET /healthz`: the health check;
 * - `/_matrix/app/v1/…`: the homeserver's transactions and queries (the appservice transport);
 * - `POST /v1/relay/events`: the event relay's signed deliveries (`relay.ts`);
 * - `/v1/boards…`: the operator's board opt-in API (`boards.ts`).
 *
 * Anything else is 404.
 */
import {
  APPSERVICE_PREFIX,
  createAppserviceHandler,
  type CryptoTransaction,
  type EventsHandler,
} from "../appservice/index.ts";
import type { ApprovalRequestAllowed } from "../board-chat/index.ts";
import type { Config } from "../config.ts";
import type { Store, WaitKey } from "../store/index.ts";
import { BOARDS_PATH, createBoardsHandler } from "./boards.ts";
import { RELAY_EVENTS_PATH, createRelayHandler } from "./relay.ts";

export const SERVICE = "superexchange";

export interface HandlerDeps {
  config: Pick<
    Config,
    "hsToken" | "relayDeliverySecret" | "operatorTokenSha256"
  >;
  store: Store;
  onEvents: EventsHandler;
  /** A homeserver transaction's crypto parts, before its events; absent, they are not read. */
  onCrypto?: (tx: CryptoTransaction) => void | Promise<void>;
  /** Told of each gate the relay accepted. */
  onGateAccepted?: (gateId: string) => void;
  /** Told of each question the relay accepted. */
  onQuestionAccepted?: (elicitationId: string) => void;
  /** Told of each follow-up the relay accepted. */
  onFollowupAccepted?: (gateId: string) => void;
  /** Told of each waiting card the relay accepted. */
  onAttentionAccepted?: (key: WaitKey) => void;
  /** May an approval request on this board be kept? Absent: never. */
  approvalRequestAllowed?: ApprovalRequestAllowed;
  log?: (line: string) => void;
  /** Test seam for the relay signature's clock. */
  nowMs?: () => number;
}

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? console.log;
  const appservice = createAppserviceHandler({
    hsToken: deps.config.hsToken,
    store: deps.store,
    onEvents: deps.onEvents,
    ...(deps.onCrypto ? { onCrypto: deps.onCrypto } : {}),
    log,
  });
  const relay = createRelayHandler({
    secret: deps.config.relayDeliverySecret,
    store: deps.store,
    log,
    ...(deps.onGateAccepted ? { onGateAccepted: deps.onGateAccepted } : {}),
    ...(deps.onQuestionAccepted
      ? { onQuestionAccepted: deps.onQuestionAccepted }
      : {}),
    ...(deps.onFollowupAccepted
      ? { onFollowupAccepted: deps.onFollowupAccepted }
      : {}),
    ...(deps.onAttentionAccepted
      ? { onAttentionAccepted: deps.onAttentionAccepted }
      : {}),
    ...(deps.approvalRequestAllowed
      ? { approvalRequestAllowed: deps.approvalRequestAllowed }
      : {}),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
  });
  const boards = createBoardsHandler({
    operatorTokenSha256: deps.config.operatorTokenSha256,
    store: deps.store,
    log,
  });

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      if (request.method === "GET" || request.method === "HEAD") {
        return Response.json({ ok: true, service: SERVICE });
      }
      return notFound();
    }
    if (pathname.startsWith(APPSERVICE_PREFIX)) return appservice(request);
    if (pathname === RELAY_EVENTS_PATH) {
      return request.method === "POST" ? relay(request) : notFound();
    }
    if (pathname === BOARDS_PATH || pathname.startsWith(`${BOARDS_PATH}/`)) {
      return boards(request);
    }
    return notFound();
  };
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });
