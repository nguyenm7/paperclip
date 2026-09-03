import { createHmac, randomUUID } from "node:crypto";
import {
  productFeedbackGrantSchema,
  type ProductFeedbackBrokerRequest,
  type ProductFeedbackGrant,
} from "@paperclipai/shared";

const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("feedback_broker_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("feedback_broker_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}

export interface ProductFeedbackBrokerConfig {
  endpoint: string;
  issuerId: string;
  issuerSecret: string;
}

function signature(input: { secret: string; timestamp: string; nonce: string; body: string }): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.nonce}\n${input.body}`)
    .digest("base64url");
}

export function createHttpProductFeedbackGrantBroker(
  config: ProductFeedbackBrokerConfig,
  fetchImpl: typeof fetch = fetch,
) {
  return {
    async issueGrant(request: ProductFeedbackBrokerRequest): Promise<ProductFeedbackGrant> {
      const body = JSON.stringify(request);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Paperclip-Issuer": config.issuerId,
          "X-Paperclip-Timestamp": timestamp,
          "X-Paperclip-Nonce": nonce,
          "X-Paperclip-Signature": `v1=${signature({ secret: config.issuerSecret, timestamp, nonce, body })}`,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`feedback_broker_http_${response.status}`);
      }
      const responseBody = await readBoundedResponseText(response);
      return productFeedbackGrantSchema.parse(JSON.parse(responseBody));
    },
  };
}
