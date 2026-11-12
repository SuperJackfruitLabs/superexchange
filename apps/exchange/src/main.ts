/**
 * SuperExchange: the suite's communication server. Reads its settings, opens its store, wires
 * board chat to the transport, then listens, and queues every gate delivered but not yet posted.
 */
import { countEventTypes, createClient } from "./appservice/index.ts";
import { createBoardChat, createBoardRooms } from "./board-chat/index.ts";
import { loadConfig } from "./config.ts";
import { SERVICE, createHandler } from "./routes/index.ts";
import { openStore } from "./store/index.ts";

const config = loadConfig(process.env);
const store = openStore(config.dataDir);
console.log(`${SERVICE}: store at schema version ${store.schemaVersion()}`);

if (config.plaintextRooms) {
  console.log(
    `${SERVICE}: board rooms are made and posted into WITHOUT end-to-end encryption (staging only)`,
  );
}

const log = (line: string) => console.log(line);
const client = createClient(config);
const boardChat = createBoardChat({
  store,
  client,
  rooms: createBoardRooms({
    store,
    client,
    serverName: config.serverName,
    log,
  }),
  plaintextRooms: config.plaintextRooms,
  log,
});
const countEvents = countEventTypes(log);

const server = Bun.serve({
  port: config.port,
  fetch: createHandler({
    config,
    store,
    onEvents: async (txnId, events) => {
      await countEvents(txnId, events);
      await boardChat.onEvents(txnId, events);
    },
    onGateAccepted: boardChat.gateAccepted,
    log,
  }),
});
console.log(`${SERVICE}: listening on :${server.port}`);
boardChat.resume();

async function shutdown() {
  await server.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
