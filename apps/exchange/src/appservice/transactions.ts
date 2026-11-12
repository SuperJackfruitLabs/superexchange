/**
 * The homeserver's side of the Application Service API (Matrix spec, Application Service API
 * v1): the routes under `/_matrix/app/v1/` that a homeserver calls with this registration's
 * `hs_token`.
 *
 * - `PUT /transactions/:txnId`: events pushed to this service. Applied once per transaction id,
 *   recorded in the store before the events are handled, so a retry after a crash is not applied
 *   twice. Always `{}` once authorised: the homeserver reads anything else as "not delivered" and
 *   retries the whole transaction, so one bad event must not block every one after it.
 * - `POST /ping`: the homeserver proving it can reach us. `{}`.
 * - `GET /users/:userId`, `GET /rooms/:alias`: "does this exist in your namespace?". Nothing is
 *   provisioned yet, so the honest answer is 404 `M_NOT_FOUND`.
 *
 * Authorisation is the spec's: `Authorization: Bearer <hs_token>`, or the legacy
 * `?access_token=` query. No token is 401 `M_UNAUTHORIZED`; a wrong one is 403 `M_FORBIDDEN`.
 * Neither answer says anything else, and no token reaches a log.
 */
import { secretMatches } from "../config.ts";
import type { Store } from "../store/index.ts";

/** Where these routes live. */
export const APPSERVICE_PREFIX = "/_matrix/app/v1/";

/** An event as the homeserver pushes it. Only what the transport reads is named. */
export interface MatrixEvent {
  type: string;
  sender?: string;
  room_id?: string;
  event_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** What is done with a new transaction's events. */
export type EventsHandler = (
  txnId: string,
  events: MatrixEvent[],
) => void | Promise<void>;

export interface AppserviceDeps {
  /** The token the homeserver presents (the registration's `hs_token`). */
  hsToken: string;
  store: Pick<Store, "claimTransaction">;
  onEvents: EventsHandler;
  log?: (line: string) => void;
}

/** The longest transaction id this service records. */
const MAX_TXN_ID = 255;

/**
 * The handler this slice ships: count the events by type and log the counts. No content, no
 * sender and no room reaches the log.
 */
export function countEventTypes(
  log: (line: string) => void = console.log,
): EventsHandler {
  return (txnId, events) => {
    const types: Record<string, number> = {};
    for (const event of events) {
      const type = event.type.slice(0, 100);
      types[type] = (types[type] ?? 0) + 1;
    }
    log(
      `appservice: transaction ${JSON.stringify(txnId)} with ${events.length} event(s) ${JSON.stringify(types)}`,
    );
  };
}

/** Answer a request under `/_matrix/app/v1/`. */
export function createAppserviceHandler(deps: AppserviceDeps) {
  const log = deps.log ?? console.log;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const rest = url.pathname.slice(APPSERVICE_PREFIX.length);

    const denied = authorise(request, url, deps.hsToken);
    if (denied) return denied;

    const [route, param, ...extra] = rest.split("/");
    if (extra.length > 0 || (route !== "ping" && !param)) return unrecognised();

    if (route === "transactions" && param !== undefined) {
      if (request.method !== "PUT") return unrecognised(405);
      const txnId = decoded(param);
      if (txnId === null) return matrixError(400, "M_INVALID_PARAM");
      return transaction(txnId, request);
    }
    if (route === "ping" && param === undefined) {
      if (request.method !== "POST") return unrecognised(405);
      return Response.json({});
    }
    if (route === "users" || route === "rooms") {
      if (request.method !== "GET") return unrecognised(405);
      return matrixError(404, "M_NOT_FOUND");
    }
    return unrecognised();
  };

  async function transaction(
    txnId: string,
    request: Request,
  ): Promise<Response> {
    if (txnId === "" || txnId.length > MAX_TXN_ID) {
      return matrixError(400, "M_INVALID_PARAM");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // A retry cannot fix malformed JSON, so it is acknowledged and not recorded.
      log(`appservice: transaction ${JSON.stringify(txnId)} is not JSON`);
      return Response.json({});
    }
    if (!deps.store.claimTransaction(txnId)) {
      log(`appservice: transaction ${JSON.stringify(txnId)} already applied`);
      return Response.json({});
    }
    const events = eventsOf(body);
    try {
      await deps.onEvents(txnId, events);
    } catch (error) {
      // Only the error's name: a message may quote the event it failed on.
      const name = error instanceof Error ? error.name : "unknown";
      log(
        `appservice: transaction ${JSON.stringify(txnId)} handler threw ${name}`,
      );
    }
    return Response.json({});
  }
}

/** The transaction's events that have a type; anything else is not an event. */
function eventsOf(body: unknown): MatrixEvent[] {
  if (typeof body !== "object" || body === null) return [];
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.filter(
    (e): e is MatrixEvent =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as { type?: unknown }).type === "string",
  );
}

/** Null when the request carries the hs_token; otherwise the spec's refusal. */
function authorise(
  request: Request,
  url: URL,
  hsToken: string,
): Response | null {
  const header = request.headers.get("authorization");
  let presented: string | null = null;
  if (header !== null) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    presented = match?.[1] ?? "";
  } else {
    presented = url.searchParams.get("access_token");
  }
  if (presented === null || presented === "") {
    return matrixError(401, "M_UNAUTHORIZED");
  }
  if (!secretMatches(hsToken, presented)) {
    return matrixError(403, "M_FORBIDDEN");
  }
  return null;
}

/** A path segment, percent-decoded; null when it is not valid percent-encoding. */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function unrecognised(status = 404): Response {
  return matrixError(status, "M_UNRECOGNIZED");
}

function matrixError(status: number, errcode: string): Response {
  return Response.json({ errcode }, { status });
}
