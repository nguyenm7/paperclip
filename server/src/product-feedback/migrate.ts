import { readFile } from "node:fs/promises";
import { createPostgresClient } from "@paperclipai/db/postgres-client";
import { z } from "zod";

const databaseUrl = z.string().min(1).parse(process.env.PRODUCT_FEEDBACK_DATABASE_URL);
const migrationUrl = new URL("./migrations/0001_feedback_intake.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");
const sql = createPostgresClient(databaseUrl, { max: 1, prepare: false });
try {
  await sql.unsafe(migration);
} finally {
  await sql.end({ timeout: 5 });
}
