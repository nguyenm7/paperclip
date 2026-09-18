#!/usr/bin/env node
// Minimal JSON helper for the plugin's shell scripts. Node is already required
// to run Paperclip, so this keeps the plugin dependency-free (no jq).
//
//   pick                      stdin: an API response -> TSV "identifier<TAB>id<TAB>status"
//                             Finds the first object carrying a status next to an id,
//                             whatever envelope the response uses.
//   fields <file> <key...>    TSV of those top-level keys; missing keys are empty
//   obj key=value ...         a JSON object on stdout; "key:=1" / "key:=true" pass raw JSON

import { readFileSync } from "node:fs";

const [mode, ...rest] = process.argv.slice(2);

const readStdin = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const findIssueNode = (root) => {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    const hasStatus = typeof value.status === "string";
    const hasId = typeof value.id === "string" || typeof value.identifier === "string";
    if (hasStatus && hasId) return value;
    for (const item of Object.values(value)) {
      const hit = walk(item);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
};

const writeRow = (...cells) => process.stdout.write(cells.join("\t") + "\n");

const main = async () => {
  if (mode === "pick") {
    let parsed;
    try {
      parsed = JSON.parse(await readStdin());
    } catch {
      process.exit(1);
    }
    const node = findIssueNode(parsed);
    if (!node) process.exit(1);
    writeRow(node.identifier ?? node.id ?? "", node.id ?? "", node.status ?? "unknown");
    return;
  }

  if (mode === "fields") {
    const [file, ...keys] = rest;
    const data = readJsonFile(file);
    if (!data) process.exit(1);
    writeRow(
      ...keys.map((key) => {
        const value = data[key];
        if (value === undefined || value === null) return "";
        return typeof value === "object" ? JSON.stringify(value) : String(value);
      })
    );
    return;
  }

  if (mode === "obj") {
    const obj = {};
    for (const pair of rest) {
      const rawAt = pair.indexOf(":=");
      if (rawAt > 0) {
        const key = pair.slice(0, rawAt);
        const raw = pair.slice(rawAt + 2);
        try {
          obj[key] = JSON.parse(raw);
        } catch {
          obj[key] = raw;
        }
        continue;
      }
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      obj[key] = value === "" ? null : value;
    }
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    return;
  }

  process.stderr.write("json.mjs: expected pick | fields | obj\n");
  process.exit(2);
};

main();
