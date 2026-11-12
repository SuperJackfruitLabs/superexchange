/**
 * The Matrix Application Service transport: the homeserver's transactions in, the client-server
 * API out, as this service's own registration. Above config and the store; nothing here knows a
 * board.
 *
 * - `transactions.ts`: the routes the homeserver calls under `/_matrix/app/v1/`.
 * - `client.ts`: the client-server calls made with the `as_token`.
 *
 * End-to-end encryption arrives in a later step; nothing here decrypts or encrypts.
 */
export {
  APPSERVICE_PREFIX,
  countEventTypes,
  createAppserviceHandler,
  type AppserviceDeps,
  type EventsHandler,
  type MatrixEvent,
} from "./transactions.ts";
export {
  MatrixClientError,
  createClient,
  type AppserviceClient,
  type ClientDeps,
} from "./client.ts";
