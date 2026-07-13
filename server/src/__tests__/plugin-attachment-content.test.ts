/**
 * Host-services regression suite for the plugin attachment content bridge
 * (LOOA-247). The vulnerability class this encodes: attachment bytes must
 * only be reachable through the capability-gated, company-scoped bridge —
 * cross-company ids are indistinguishable from unknown ids, oversized
 * attachments throw rather than truncate, and every content read leaves an
 * audit row attributed to the plugin.
 *
 * Capability gating itself (CAPABILITY_DENIED without
 * `issue.attachments.read`) is covered at the SDK layer in
 * packages/plugins/sdk/tests/host-client-factory.test.ts.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { storedObjects, getObjectCalls } = vi.hoisted(() => ({
  storedObjects: new Map<string, Buffer>(),
  getObjectCalls: [] as Array<{ companyId: string; objectKey: string }>,
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    getObject: async (companyId: string, objectKey: string) => {
      getObjectCalls.push({ companyId, objectKey });
      const body = storedObjects.get(objectKey);
      if (!body) throw new Error(`missing test object: ${objectKey}`);
      return { stream: Readable.from([body]), contentType: null, byteSize: body.length };
    },
  }),
}));

import { buildHostServices } from "../services/plugin-host-services.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin attachment-content tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

describeEmbeddedPostgres("plugin attachment content host services (LOOA-247)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-attachments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithAttachment(bytes: Buffer, opts?: { byteSizeOverride?: number }) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Loops",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Visual gate",
      status: "in_review",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-1`,
    });
    const objectKey = `issues/${issueId}/${randomUUID()}.png`;
    storedObjects.set(objectKey, bytes);
    const attachment = await issueService(db).createAttachment({
      issueId,
      provider: "local-disk",
      objectKey,
      contentType: "image/png",
      byteSize: opts?.byteSizeOverride ?? bytes.length,
      sha256: "0".repeat(64),
      originalFilename: "contact-sheet.png",
    });
    return { companyId, issueId, attachment };
  }

  it("round-trips attachment bytes for the owning company and logs the read", async () => {
    const bytes = Buffer.from("png-bytes-for-the-visual-gate");
    const { companyId, issueId, attachment } = await seedIssueWithAttachment(bytes);
    const services = buildHostServices(db, randomUUID(), "paperclip.gateway-test", createEventBusStub());

    const listed = await services.issues.listAttachments({ issueId, companyId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: attachment.id,
      issueId,
      contentType: "image/png",
      byteSize: bytes.length,
      originalFilename: "contact-sheet.png",
    });
    // Storage internals must not cross the bridge.
    expect(listed[0]).not.toHaveProperty("objectKey");
    expect(listed[0]).not.toHaveProperty("provider");

    const content = await services.issues.getAttachmentContent({
      attachmentId: attachment.id,
      companyId,
    });
    expect(content).not.toBeNull();
    expect(Buffer.from(content!.contentBase64, "base64").toString()).toBe(bytes.toString());

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.attachment_content_read"));
    const row = audit.find((entry) => (entry.details as any)?.attachmentId === attachment.id);
    expect(row).toBeDefined();
    expect(row!.actorType).toBe("plugin");
    expect(row!.entityId).toBe(issueId);
  });

  it("treats another company's attachment id exactly like an unknown id (no existence leak)", async () => {
    const { attachment, issueId } = await seedIssueWithAttachment(Buffer.from("company-a-secret"));
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    const services = buildHostServices(db, randomUUID(), "paperclip.gateway-test", createEventBusStub());
    getObjectCalls.length = 0;

    const crossCompany = await services.issues.getAttachmentContent({
      attachmentId: attachment.id,
      companyId: otherCompanyId,
    });
    const unknown = await services.issues.getAttachmentContent({
      attachmentId: randomUUID(),
      companyId: otherCompanyId,
    });
    expect(crossCompany).toBeNull();
    expect(crossCompany).toEqual(unknown);
    expect(getObjectCalls).toHaveLength(0);

    const foreignList = await services.issues.listAttachments({ issueId, companyId: otherCompanyId });
    expect(foreignList).toEqual([]);
  });

  it("throws instead of truncating when the attachment exceeds the byte cap", async () => {
    const { companyId, attachment } = await seedIssueWithAttachment(Buffer.from("small"), {
      byteSizeOverride: 26 * 1024 * 1024,
    });
    const services = buildHostServices(db, randomUUID(), "paperclip.gateway-test", createEventBusStub());
    getObjectCalls.length = 0;

    await expect(
      services.issues.getAttachmentContent({ attachmentId: attachment.id, companyId }),
    ).rejects.toThrow(/content cap/);
    // The oversized read must be refused before any storage I/O.
    expect(getObjectCalls).toHaveLength(0);

    await expect(
      services.issues.getAttachmentContent({ attachmentId: attachment.id, companyId, maxBytes: 1024 }),
    ).rejects.toThrow(/content cap/);
  });

  it("honors a caller maxBytes below the hard ceiling", async () => {
    const bytes = Buffer.from("x".repeat(2048));
    const { companyId, attachment } = await seedIssueWithAttachment(bytes);
    const services = buildHostServices(db, randomUUID(), "paperclip.gateway-test", createEventBusStub());

    await expect(
      services.issues.getAttachmentContent({ attachmentId: attachment.id, companyId, maxBytes: 1024 }),
    ).rejects.toThrow(/content cap/);

    const withinCap = await services.issues.getAttachmentContent({
      attachmentId: attachment.id,
      companyId,
      maxBytes: 4096,
    });
    expect(withinCap?.byteSize).toBe(2048);
  });
});
