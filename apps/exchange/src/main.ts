/**
 * SuperExchange: the suite's communication server. Reads its settings, then listens.
 */
import { loadConfig } from "./config.ts";
import { SERVICE, handle } from "./routes/index.ts";

const config = loadConfig(process.env);

const server = Bun.serve({ port: config.port, fetch: handle });
console.log(`${SERVICE}: listening on :${server.port}`);

async function shutdown() {
  await server.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
