import { createServer } from "node:http";
import { loadGatewayConfig } from "./config.js";
import { createFeedbackGateway } from "./gateway.js";
import { drainHttpServer } from "./gateway-lifecycle.js";
import { PostgresFeedbackStore } from "./postgres-store.js";

const config = loadGatewayConfig();
const store = PostgresFeedbackStore.connect(config.PRODUCT_FEEDBACK_DATABASE_URL);
const app = createFeedbackGateway({ config, store });
const server = createServer(app);

server.listen(config.PORT, "0.0.0.0", () => {
  process.stdout.write(`paperclip product feedback gateway listening on ${config.PORT}\n`);
});

let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    await drainHttpServer(server);
  } finally {
    await store.close();
  }
}

function handleShutdownSignal(): void {
  void shutdown().catch((error: unknown) => {
    process.stderr.write(`paperclip product feedback gateway shutdown failed: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`);
    process.exitCode = 1;
  });
}

process.once("SIGINT", handleShutdownSignal);
process.once("SIGTERM", handleShutdownSignal);
