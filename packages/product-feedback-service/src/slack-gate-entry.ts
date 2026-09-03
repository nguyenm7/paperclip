import { readFile } from "node:fs/promises";
import { loadSlackHumanGateConfig } from "./config.js";
import { SlackHumanGateClient } from "./slack-client.js";

const MAX_INPUT_BYTES = 64 * 1024;
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const command = args.shift();
const client = new SlackHumanGateClient(loadSlackHumanGateConfig());

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path);
  if (raw.byteLength > MAX_INPUT_BYTES) throw new Error("slack_gate_input_too_large");
  return JSON.parse(raw.toString("utf8"));
}

if (command === "setup" && args.length === 0) {
  process.stdout.write(JSON.stringify(await client.verifyTarget({ join: true })) + "\n");
} else if (command === "post" && args.length === 1) {
  process.stdout.write(JSON.stringify(await client.postRecommendation(await readJson(args[0]!))) + "\n");
} else if (command === "notify" && args.length === 1) {
  process.stdout.write(JSON.stringify(await client.postReviewNotification(await readJson(args[0]!))) + "\n");
} else if (command === "decision" && args.length === 1) {
  process.stdout.write(JSON.stringify(await client.readDecision(args[0]!)) + "\n");
} else {
  throw new Error("usage: slack:gate -- setup | post <recommendation.json> | notify <review.json> | decision <thread-ts>");
}
