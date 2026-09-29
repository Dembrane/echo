import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate, schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { DEFAULT_TOPICS, seedDefaultTopics } from "../src/defaults";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_defaults_${process.pid}`;
const { verification_topic, verification_topic_translations: translations } = schema;

setDefaultTimeout(60_000);

run("seedDefaultTopics", () => {
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("a fresh database gets every topic and label, and a second run adds nothing", async () => {
    expect(await seedDefaultTopics(database.db)).toEqual({
      topicsAdded: 6,
      translationsAdded: 48,
      translationsUpdated: 0,
    });
    expect(await seedDefaultTopics(database.db)).toEqual({
      topicsAdded: 0,
      translationsAdded: 0,
      translationsUpdated: 0,
    });
    const topics = await database.db.select().from(verification_topic);
    expect(topics.map((t) => t.key).sort()).toEqual(DEFAULT_TOPICS.map((t) => t.key).sort());
  });

  test("a changed label is reset and a missing one is added back", async () => {
    const gemsNl = and(
      eq(translations.verification_topic_key, "gems"),
      eq(translations.languages_code, "nl-NL"),
    );
    await database.db.update(translations).set({ label: "Oud" }).where(gemsNl);
    await database.db
      .delete(translations)
      .where(
        and(
          eq(translations.verification_topic_key, "gems"),
          eq(translations.languages_code, "de-DE"),
        ),
      );
    expect(await seedDefaultTopics(database.db)).toEqual({
      topicsAdded: 0,
      translationsAdded: 1,
      translationsUpdated: 1,
    });
    const [row] = await database.db.select().from(translations).where(gemsNl);
    expect(row?.label).toBe("Verborgen parels");
  });

  test("an edited default topic keeps its prompt, icon and sort", async () => {
    const edited = { prompt: "Our own prompt.", icon: ":star:", sort: 9 };
    await database.db
      .update(verification_topic)
      .set(edited)
      .where(eq(verification_topic.key, "agreements"));
    expect(await seedDefaultTopics(database.db)).toEqual({
      topicsAdded: 0,
      translationsAdded: 0,
      translationsUpdated: 0,
    });
    const [row] = await database.db
      .select()
      .from(verification_topic)
      .where(eq(verification_topic.key, "agreements"));
    expect(row).toMatchObject(edited);
  });

  test("a project's own topic under a default key keeps its labels", async () => {
    // The key is the primary key, so the project topic can only exist without the global one.
    await database.db.delete(translations).where(eq(translations.verification_topic_key, "truths"));
    await database.db.delete(verification_topic).where(eq(verification_topic.key, "truths"));
    const projectId = "0199a000-0000-7000-8000-000000000001";
    await database.db
      .insert(schema.project)
      .values({ id: projectId, is_conversation_allowed: true });
    await database.db
      .insert(verification_topic)
      .values({ key: "truths", project_id: projectId, prompt: "Project prompt." });
    await database.db
      .insert(translations)
      .values({ verification_topic_key: "truths", languages_code: "en-US", label: "Our truths" });
    expect(await seedDefaultTopics(database.db)).toEqual({
      topicsAdded: 0,
      translationsAdded: 0,
      translationsUpdated: 0,
    });
    const [topic] = await database.db
      .select()
      .from(verification_topic)
      .where(eq(verification_topic.key, "truths"));
    expect(topic).toMatchObject({ project_id: projectId, prompt: "Project prompt." });
    const labels = await database.db
      .select({ code: translations.languages_code, label: translations.label })
      .from(translations)
      .where(eq(translations.verification_topic_key, "truths"));
    expect(labels).toEqual([{ code: "en-US", label: "Our truths" }]);
  });
});
