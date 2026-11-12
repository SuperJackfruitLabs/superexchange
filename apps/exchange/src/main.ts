/**
 * SuperExchange: the suite's communication server. Reads its settings, opens its store, then
 * listens.
 */
import { countEventTypes } from "./appservice/index.ts";
import { loadConfig } from "./config.ts";
import { SERVICE, createHandler } from "./routes/index.ts";
import { openStore } from "./store/index.ts";

const config = loadConfig(process.env);
const store = openStore(config.dataDir);
console.log(`${SERVICE}: store at schema version ${store.schemaVersion()}`);

const server = Bun.serve({
  port: config.port,
  fetch: createHandler({ config, store, onEvents: countEventTypes() }),
});
console.log(`${SERVICE}: listening on :${server.port}`);

async function shutdown() {
  await server.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
