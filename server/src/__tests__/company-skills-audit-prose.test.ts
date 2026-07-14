import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  companySkillService,
  nonInventoryLinkPattern,
  secretConstantPattern,
  secretEnvAccessPattern,
} from "../services/company-skills.ts";

// secret_reference fires at severity "warning" against all skill text, .md prose included.
// Prose that names a secret ("never paste a token") must not flag, while literal constant
// or accessor shapes still must — a safety standard's job is to name the dangerous thing
// without being reported for it (LOOA-328).

const secretReference = (text: string) =>
  secretEnvAccessPattern.test(text) || secretConstantPattern.test(text);

const mustFlagSecret: Array<[label: string, content: string]> = [
  ["process.env accessor", "const key = process.env.STRIPE_KEY"],
  ["printenv invocation", "printenv | grep AWS_"],
  [".env file reference", "dotenv loads prod.env at boot"],
  ["API_KEY constant", "API_KEY=sk-live-1234"],
  ["ALL-CAPS TOKEN constant", "Set TOKEN before running the importer."],
  ["ALL-CAPS SECRET constant", "SECRET: ${{ github.secret }}"],
  ["ALL-CAPS PASSWORD constant", "PASSWORD=hunter2"],
];

const mustPassSecret: Array<[label: string, content: string]> = [
  ["prose naming secrets in lowercase", "Never paste a token, secret, or password into a comment."],
  ["Title Case heading", "## Rotating Your Password"],
  ["token as a budget noun", "the token budget for this run is 500k"],
  ["secret as an adjective", "a secret admirer wrote the spec"],
  ["Mixed-case Token", "Refresh the Token Sheet before the review."],
];

describe("secret_reference audit patterns", () => {
  for (const [label, content] of mustFlagSecret) {
    it(`flags ${label}`, () => {
      expect(secretReference(content)).toBe(true);
    });
  }
  for (const [label, content] of mustPassSecret) {
    it(`does not flag ${label}`, () => {
      expect(secretReference(content)).toBe(false);
    });
  }

  // Documented residual (LOOA-328): case alone cannot distinguish an ALL-CAPS tokenizer
  // constant (`const TOKEN = /<…>/`) from an ALL-CAPS secret constant. The warning is the
  // accepted cost of keeping the true-positive direction intact.
  it("accepts the documented residual: non-secret ALL-CAPS TOKEN identifier still flags", () => {
    expect(secretReference("const TOKEN = /<\\/?([A-Za-z]+)>/g")).toBe(true);
  });
});

// broken_internal_link only verifies links that could be files in the skill directory.
// Root-absolute links are app routes — the company comment style mandates the
// /PREFIX/issues/… form — so they are out of scope like external URLs (LOOA-328).

const mustSkipLinks = [
  "/LOOA/issues/LOOA-33",
  "/LOOA/issues/LOOA-222#document-gate-policy",
  "/LOOA/agents/cto",
  "https://example.com/doc",
  "HTTPS://EXAMPLE.COM",
  "mailto:michael@paperclip.ing",
  "#local-anchor",
];

const mustCheckLinks = [
  "docs/reference.md",
  "./reference.md",
  "../shared/tokens.md",
  "SKILL.md#usage",
  "scripts/render.mjs",
];

describe("nonInventoryLinkPattern (broken_internal_link scope)", () => {
  for (const link of mustSkipLinks) {
    it(`skips ${link}`, () => {
      expect(nonInventoryLinkPattern.test(link)).toBe(true);
    });
  }
  for (const link of mustCheckLinks) {
    it(`checks ${link}`, () => {
      expect(nonInventoryLinkPattern.test(link)).toBe(false);
    });
  }
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project scan tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A project with zero workspace rows previously fell through every skipped/warning path,
// so a scan that looked nowhere returned the same success shape as a scan that found
// nothing (LOOA-328 / LOOA-327 finding #1).
describeEmbeddedPostgres("scanProjectWorkspaces zero-workspace projects", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-scan-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-skills-scan-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("reports zero-workspace projects in skipped and warnings instead of a silent no-op", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Signal Aggregator",
    });

    const result = await svc.scanProjectWorkspaces(companyId);
    expect(result.scannedProjects).toBe(0);
    expect(result.scannedWorkspaces).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      projectId,
      projectName: "Signal Aggregator",
      workspaceId: null,
      workspaceName: null,
      path: null,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Signal Aggregator");
    expect(result.warnings[0]).toContain("no registered workspaces");
  });

  it("stays quiet about zero-workspace projects when the scan targets specific workspaces", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(projects).values({
      id: randomUUID(),
      companyId,
      name: "Signal Aggregator",
    });

    const result = await svc.scanProjectWorkspaces(companyId, { workspaceIds: [randomUUID()] });
    expect(result.skipped).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
