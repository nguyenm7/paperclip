import { setTimeout as wait } from "node:timers/promises";
import { AsanaClient } from "./asana.js";
import { loadWorkerConfig } from "./config.js";
import { PostgresFeedbackStore } from "./postgres-store.js";
import { runFeedbackWorkerOnce } from "./worker.js";

const config = loadWorkerConfig();
const store = PostgresFeedbackStore.connect(config.PRODUCT_FEEDBACK_DATABASE_URL);
const asana = new AsanaClient({
  accessToken: config.PRODUCT_FEEDBACK_ASANA_ACCESS_TOKEN,
  apiBaseUrl: config.PRODUCT_FEEDBACK_ASANA_API_BASE_URL,
  projectGid: config.PRODUCT_FEEDBACK_ASANA_PROJECT_GID,
  validationSectionGid: config.PRODUCT_FEEDBACK_ASANA_VALIDATION_SECTION_GID,
  newSectionGid: config.PRODUCT_FEEDBACK_ASANA_NEW_SECTION_GID,
  customFields: config.PRODUCT_FEEDBACK_ASANA_CUSTOM_FIELDS_JSON,
});
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const result = await runFeedbackWorkerOnce({ store, asana });
  if (result === "idle") await wait(2_000);
}
await store.close();
