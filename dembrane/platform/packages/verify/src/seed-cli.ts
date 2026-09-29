#!/usr/bin/env bun
/** bun run seed:verification-topics: adds the default verification topics to DATABASE_URL. */
import { createDb } from "@dembrane/db";
import { seedDefaultTopics } from "./defaults";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const database = createDb({ url, poolMax: 1 });
try {
  process.stdout.write(`${JSON.stringify(await seedDefaultTopics(database.db))}\n`);
} finally {
  await database.close();
}
