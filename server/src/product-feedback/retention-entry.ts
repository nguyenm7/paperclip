import { loadGatewayConfig } from "./config.js";
import { PostgresFeedbackStore } from "./postgres-store.js";

const config = loadGatewayConfig();
const store = PostgresFeedbackStore.connect(config.PRODUCT_FEEDBACK_DATABASE_URL);

try {
  await store.purgeExpired(new Date(), config.PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS);
} finally {
  await store.close();
}
