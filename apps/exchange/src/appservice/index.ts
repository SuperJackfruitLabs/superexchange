/**
 * The Matrix Application Service transport: the homeserver's transactions in, the client-server
 * API out, as this service's own registration. Above config and the store; nothing here knows a
 * board.
 *
 * - `transactions.ts`: the routes the homeserver calls under `/_matrix/app/v1/`.
 * - `client.ts`: the client-server calls made with the `as_token`.
 * - `crypto.ts`: the speaker's end-to-end encryption (its device, its keys, encrypting and
 *   decrypting room events), carried by `crypto-transport.ts`; `open-machines.ts` closes every
 *   machine before the process exits.
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
  ROOM_ENCRYPTION_STATE,
  createClient,
  type AppserviceClient,
  type ClientDeps,
  type CreateRoomOptions,
} from "./client.ts";
export {
  CryptoError,
  ENCRYPTED_EVENT_TYPE,
  createSpeakerCrypto,
  cryptoTransactionOf,
  hasCryptoChanges,
  type CryptoTransaction,
  type DecryptedEvent,
  type RoomCrypto,
  type SpeakerCrypto,
  type SpeakerCryptoDeps,
} from "./crypto.ts";
export {
  createCryptoTransport,
  type CryptoTransport,
} from "./crypto-transport.ts";
