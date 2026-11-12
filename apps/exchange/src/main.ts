/**
 * SuperExchange: the suite's communication server. Reads its settings, opens its store, builds
 * the speaker's encryption (its device and keys), wires board chat to the transport (gate cards
 * out, people's answers to them back), then listens, gives back any answer a stopped run left
 * unfinished, queues every gate delivered but not yet posted, and tries again every encrypted
 * event still waiting for its key.
 */
import { join } from "node:path";
import {
  countEventTypes,
  createClient,
  createCryptoTransport,
  createSpeakerCrypto,
} from "./appservice/index.ts";
import {
  createAccounts,
  createBoardChat,
  createBoardRooms,
  createGateAnswers,
  createRoomSender,
  describe,
  resolveGateAtSuperpipeline,
} from "./board-chat/index.ts";
import { loadConfig } from "./config.ts";
import { SERVICE, createHandler } from "./routes/index.ts";
import { openStore } from "./store/index.ts";

const config = loadConfig(process.env);
const store = openStore(config.dataDir);
console.log(`${SERVICE}: store at schema version ${store.schemaVersion()}`);

if (config.plaintextRooms) {
  console.log(
    `${SERVICE}: new board rooms are made WITHOUT end-to-end encryption (staging only)`,
  );
}

const log = (line: string) => console.log(line);
const client = createClient(config);
const rooms = createBoardRooms({
  store,
  client,
  serverName: config.serverName,
  encryptNewRooms: !config.plaintextRooms,
  log,
});
const crypto =
  config.cryptoPassphrase === null
    ? null
    : createSpeakerCrypto({
        userId: rooms.speaker,
        storeDir: join(config.dataDir, "crypto"),
        passphrase: config.cryptoPassphrase,
        store,
        client,
        transport: createCryptoTransport(config),
        log,
      });
const sender = createRoomSender({
  store,
  client,
  crypto,
  plaintextRooms: config.plaintextRooms,
});
const accounts = createAccounts({
  url: config.orgPlaneUrl,
  credential: config.orgPlaneCredential,
});
const answers = createGateAnswers({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  resolveGate: (input) =>
    resolveGateAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      // Named for the board that verifies it: SuperPipeline checks `aud` against its own URL.
      mint: (subject) =>
        accounts.assert({ ...subject, audience: config.superpipelineUrl }),
    }),
  log,
});
const boardChat = createBoardChat({
  store,
  sender,
  rooms,
  crypto,
  answers,
  log,
});
const countEvents = countEventTypes(log);

const server = Bun.serve({
  port: config.port,
  fetch: createHandler({
    config,
    store,
    ...(crypto
      ? {
          onCrypto: async (tx) => {
            await crypto.receive(tx);
            // New keys may open events that were waiting for them.
            void boardChat
              .retryPending()
              .catch((error: unknown) =>
                log(
                  `board-chat: waiting encrypted events could not be retried (${describe(error)})`,
                ),
              );
          },
        }
      : {}),
    onEvents: async (txnId, events) => {
      await countEvents(txnId, events);
      await boardChat.onEvents(txnId, events);
    },
    onGateAccepted: boardChat.gateAccepted,
    log,
  }),
});
console.log(`${SERVICE}: listening on :${server.port}`);
if (crypto) {
  // Built now, so the speaker's device and keys are published before anybody encrypts to it.
  // A failure is logged and tried again by the next transaction or send.
  crypto.start().then(
    () => console.log(`${SERVICE}: end-to-end encryption ready`),
    (error: unknown) =>
      console.log(
        `${SERVICE}: end-to-end encryption is not ready (${describe(error)}); it is tried again on the next use`,
      ),
  );
}
boardChat.resume();

async function shutdown() {
  await server.stop();
  // Before exit: an encryption machine open at exit aborts the process.
  await crypto?.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
