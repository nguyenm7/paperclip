import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { grantClaimsSchema, type GrantClaims } from "./contracts.js";

const MAX_CLOCK_SKEW_SECONDS = 300;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function issuerSignature(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  body: Buffer | string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.nonce}\n`)
    .update(input.body)
    .digest("base64url");
}

export function verifyIssuerSignature(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  body: Buffer | string;
  signature: string;
  now?: Date;
}): boolean {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const supplied = input.signature.startsWith("v1=") ? input.signature.slice(3) : "";
  const expected = issuerSignature(input);
  return safeEqualText(supplied, expected);
}

export function issueGrantToken(input: {
  signingSecret: string;
  submissionId: string;
  installationRef: string;
  submissionMode: "local_validation" | "production_feedback";
  validationRunId?: string;
  ttlSeconds: number;
  now?: Date;
}): { token: string; claims: GrantClaims } {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims = grantClaimsSchema.parse({
    v: 1,
    jti: randomUUID(),
    submissionId: input.submissionId,
    installationRef: input.installationRef,
    submissionMode: input.submissionMode,
    ...(input.validationRunId ? { validationRunId: input.validationRunId } : {}),
    iat: issuedAt,
    exp: issuedAt + input.ttlSeconds,
  });
  const header = base64UrlJson({ alg: "HS256", typ: "PFG1" });
  const payload = base64UrlJson(claims);
  const signature = createHmac("sha256", input.signingSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return { token: `${header}.${payload}.${signature}`, claims };
}

export function verifyGrantToken(input: {
  signingSecret: string;
  token: string;
  now?: Date;
}): GrantClaims {
  const [header, payload, supplied, ...rest] = input.token.split(".");
  if (!header || !payload || !supplied || rest.length > 0) throw new Error("invalid_grant");
  const expected = createHmac("sha256", input.signingSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  if (!safeEqualText(supplied, expected)) throw new Error("invalid_grant");
  const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
  if (JSON.stringify(parsedHeader) !== JSON.stringify({ alg: "HS256", typ: "PFG1" })) throw new Error("invalid_grant");
  const claims = grantClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (claims.exp <= nowSeconds || claims.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) throw new Error("expired_grant");
  return claims;
}

export function encryptContact(value: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("contact encryption key must contain exactly 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptContact(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || rest.length > 0) throw new Error("invalid_ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function verifyStandardWebhook(input: {
  secret: string;
  rawBody: Buffer;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  now?: Date;
}): boolean {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const timestampSeconds = Number(input.webhookTimestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const encodedSecret = input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret;
  let secret: Buffer;
  try {
    secret = Buffer.from(encodedSecret, "base64");
  } catch {
    return false;
  }
  if (secret.length === 0) return false;
  const expected = createHmac("sha256", secret)
    .update(`${input.webhookId}.${timestampSeconds}.`)
    .update(input.rawBody)
    .digest("base64");
  return input.webhookSignature.split(" ").some((candidate) => {
    const [version, signature] = candidate.split(",");
    return version === "v1" && typeof signature === "string" && safeEqualText(signature, expected);
  });
}

export function verifyAsanaWebhook(input: {
  secret: string;
  rawBody: Buffer;
  signature: string;
}): boolean {
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  return safeEqualText(input.signature, expected);
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
