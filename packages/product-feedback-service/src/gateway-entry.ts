import { createServer } from "node:http";
import { loadGatewayConfig } from "./config.js";
import { createFeedbackGateway } from "./gateway.js";
import { PostgresFeedbackStore } from "./postgres-store.js";

const config = loadGatewayConfig();
const store = PostgresFeedbackStore.connect(config.PRODUCT_FEEDBACK_DATABASE_URL);
const app = createFeedbackGateway({ config, store });
const server = createServer(app);

server.listen(config.PORT, "0.0.0.0", () => {
  process.stdout.write(`paperclip product feedback gateway listening on ${config.PORT}\n`);
});

async function shutdown() {
  server.close();
  await store.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
