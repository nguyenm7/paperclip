import { readFile } from "node:fs/promises";
import { loadPaperclipTriageConfig } from "./config.js";
import { PaperclipTriageClient, feedbackTriageIntakeSchema } from "./paperclip-triage.js";

const MAX_INPUT_BYTES = 64 * 1024;
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const inputPath = args[0];
if (!inputPath || args.length !== 1) {
  throw new Error("usage: pnpm triage:once -- <normalized-feedback.json>");
}

const raw = await readFile(inputPath);
if (raw.byteLength > MAX_INPUT_BYTES) throw new Error("triage_input_too_large");
const intake = feedbackTriageIntakeSchema.parse(JSON.parse(raw.toString("utf8")));
const issue = await new PaperclipTriageClient(loadPaperclipTriageConfig()).createIssue(intake);

process.stdout.write(JSON.stringify({
  issueId: issue.id,
  identifier: issue.identifier,
  status: issue.status,
}) + "\n");
