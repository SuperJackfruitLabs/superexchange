/**
 * SuperExchange: the suite's communication server. Reads its settings, opens its store, builds
 * the speaker's encryption (its device and keys), wires board chat to the transport (gate cards,
 * questions, follow-ups and waiting cards out, the board's notices about them, people's answers,
 * pull-backs and check overrides back), then listens,
 * gives back any answer a stopped run left unfinished, queues every card delivered but not yet
 * posted, tries again every encrypted event still waiting for its key, and starts the gate,
 * question, follow-up and waiting-card sweeps (once now, then every
 * `SUPEREXCHANGE_SWEEP_SECONDS`).
 */
import { join } from "node:path";
import {
  countEventTypes,
  createClient,
  createCryptoTransport,
  createSpeakerCrypto,
} from "./appservice/index.ts";
import {
  answerAttentionAtSuperpipeline,
  answerFollowupAtSuperpipeline,
  answerQuestionAtSuperpipeline,
  createAccounts,
  createApprovalScope,
  createAttentionAnswers,
  createBoardChat,
  createBoardRooms,
  createCheckOverrides,
  createEscalationRecipients,
  createFollowupAnswers,
  createPullBacks,
  createGateAnswers,
  createQuestionAnswers,
  createRoomSender,
  createServiceTokens,
  createSuperpipelineReads,
  describe,
  overrideCheckAtSuperpipeline,
  pullBackAtSuperpipeline,
  resolveGateAtSuperpipeline,
  startAttentionSweep,
  startFollowupSweep,
  startGateSweep,
  startQuestionSweep,
  startSweeper,
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
// Named for the board that verifies it: SuperPipeline checks `aud` against its own URL.
const mint = (subject: { principalId: string; senderMxid: string }) =>
  accounts.assert({ ...subject, audience: config.superpipelineUrl });
const answers = createGateAnswers({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  resolveGate: (input) =>
    resolveGateAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      // Named for the board that verifies it: SuperPipeline checks `aud` against its own URL.
      mint,
    }),
  log,
});
const questions = createQuestionAnswers({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  answerQuestion: (input) =>
    answerQuestionAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      mint,
    }),
  log,
});
const followups = createFollowupAnswers({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  answerFollowup: (input) =>
    answerFollowupAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      mint,
    }),
  log,
});
const attention = createAttentionAnswers({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  answerAttention: (input) =>
    answerAttentionAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      mint,
    }),
  log,
});
const pullBacks = createPullBacks({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  pullBack: (input) =>
    pullBackAtSuperpipeline(input, { baseUrl: config.superpipelineUrl, mint }),
  log,
});
const overrides = createCheckOverrides({
  store,
  client: sender,
  speaker: rooms.speaker,
  accounts,
  override: (input) =>
    overrideCheckAtSuperpipeline(input, {
      baseUrl: config.superpipelineUrl,
      mint,
    }),
  log,
});
// This service's own token, for reading only: SuperPipeline checks `aud` against its URL. One
// holder for the sweeps, the notices and the approval-request rule.
const serviceTokens = createServiceTokens({
  accounts,
  audience: config.superpipelineUrl,
});
const reads = createSuperpipelineReads({
  baseUrl: config.superpipelineUrl,
  tokens: serviceTokens,
});
const boardChat = createBoardChat({
  store,
  sender,
  rooms,
  crypto,
  answers,
  questions,
  followups,
  attention,
  pullBacks,
  overrides,
  notices: {
    invite: (roomId, userId) => client.invite(rooms.speaker, roomId, userId),
    recipients: createEscalationRecipients({
      tokens: serviceTokens,
      accounts,
      log,
    }),
    labelFor: (principalId) => accounts.principalLabel(principalId),
    reads,
  },
  log,
});
const approvalRequestAllowed = createApprovalScope({
  tokens: serviceTokens,
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
    onQuestionAccepted: boardChat.questionAccepted,
    onFollowupAccepted: boardChat.followupAccepted,
    onAttentionAccepted: boardChat.attentionAccepted,
    onNoticeAccepted: boardChat.noticeAccepted,
    approvalRequestAllowed,
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
const sweep = startGateSweep(
  {
    store,
    board: reads,
    chat: boardChat,
    labelFor: (principalId) => accounts.principalLabel(principalId),
    log,
  },
  { intervalMs: config.sweepSeconds * 1000 },
);
const questionSweep = startQuestionSweep(
  { store, board: reads, chat: boardChat, approvalRequestAllowed, log },
  { intervalMs: config.sweepSeconds * 1000 },
);

// Both read routes SuperPipeline does not yet admit a service token on: until it does, every
// board is unreadable there, nothing is settled, and each sweep backs off on its own.
const followupSweep = startFollowupSweep(
  { store, board: reads, chat: boardChat, log },
  { intervalMs: config.sweepSeconds * 1000 },
);
const attentionSweep = startAttentionSweep(
  { store, board: reads, chat: boardChat, log },
  { intervalMs: config.sweepSeconds * 1000 },
);

// Notices not yet posted (a send that failed) and joins still owed their re-posts: nothing
// redelivers them, so they are tried again on the sweep's interval. Reads no board.
const noticeRetry = startSweeper(
  async () => {
    boardChat.retryNotices();
    await boardChat.idle();
    return { boards: 0, failedBoards: 0 };
  },
  (error) =>
    log(`board-chat: notices could not be retried (${describe(error)})`),
  { intervalMs: config.sweepSeconds * 1000 },
);

async function shutdown() {
  noticeRetry.stop();
  sweep.stop();
  questionSweep.stop();
  followupSweep.stop();
  attentionSweep.stop();
  await server.stop();
  // Before exit: an encryption machine open at exit aborts the process.
  await crypto?.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
