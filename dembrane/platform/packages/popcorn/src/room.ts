import { deckQuoteId } from "./deck";
import { dict, isRecord, type Json, list, pyStr } from "./py";

/**
 * What the room may be shown, as rules every deck the server builds keeps. Each closes a
 * way the room and the host's results came apart (ECHO-1035, #1293):
 *
 * 1. Once a session publishes, every tension, stakeholder and phrase is a published object,
 *    named by its object id, or its whole file is marked provisional (owed a publication).
 *    A slide with nothing behind it is one the host's results cannot list or hide.
 * 2. Every quote id resolves, and a phrase's quote is its own conversation's.
 * 3. Every quote id is the one its conversation and words derive (deckQuoteId), so a
 *    screen holding files from two reads can never resolve an id to another quote.
 *
 * `roomViolations` names each break; an empty list is a room that keeps them. The bundle
 * readers check every deck they build (before translation, which rewords quotes) and log a
 * break without withholding the deck; the tests hold built decks to an empty list.
 */
export function roomViolations(files: Json): string[] {
  const out: string[] = [];
  if (dict(dict(files["session.json"]).demo).synthetic === true) return out;
  const published = Object.values(files).some(
    (file) =>
      isRecord(file) &&
      (file.provisional === true ||
        ["items", "tensions", "stakeholders"].some((key) =>
          list(file[key]).some((item) => isRecord(item) && Boolean(item.objectId)),
        )),
  );
  const quotes = new Map(
    list(dict(files["quotes.json"]).quotes)
      .filter(isRecord)
      .map((q) => [pyStr(q.id), q] as const),
  );
  const cite = (where: string, id: unknown, conversation?: string) => {
    const q = quotes.get(pyStr(id));
    if (!q) {
      out.push(`${where}: quote ${pyStr(id)} is not in the registry`);
      return;
    }
    if (conversation && pyStr(q.transcript) !== conversation)
      out.push(`${where}: a quote of ${pyStr(q.transcript)} beside ${conversation}'s phrase`);
    if (pyStr(id) !== deckQuoteId(pyStr(q.transcript), pyStr(q.text)))
      out.push(`${where}: quote id ${pyStr(id)} is not derived from its words`);
  };
  for (const [name, raw] of Object.entries(files)) {
    if (!isRecord(raw)) continue;
    if (name.startsWith("popcorn/")) {
      const conversation = name.slice("popcorn/".length, -".json".length);
      for (const item of list(raw.items).filter(isRecord)) {
        if (published && !item.objectId && raw.provisional !== true)
          out.push(`${name}: phrase ${pyStr(item.id)} has no object and is not provisional`);
        if (item.quoteId) cite(name, item.quoteId, conversation);
      }
    }
    for (const key of ["tensions", "stakeholders"] as const) {
      if (name !== `${key}.json`) continue;
      for (const item of list(raw[key]).filter(isRecord)) {
        if (published && raw.provisional !== true && (!item.objectId || item.id !== item.objectId))
          out.push(`${name}: ${pyStr(item.id)} is not named by its object`);
        for (const id of list(item.quoteIds)) cite(name, id);
      }
      for (const relation of list(raw.relations).filter(isRecord))
        for (const aspect of list(relation.aspects).filter(isRecord))
          for (const id of list(aspect.quoteIds)) cite(`${name} relation`, id);
    }
  }
  return out;
}

const lastLogged = new Map<string, number>();

/** Thrown under `bun test`: any test that builds a deck is held to the room's rules. */
export class RoomRulesBroken extends Error {}

/**
 * Logs a deck that breaks the room's rules, at most once a minute per deck, and serves it:
 * a room is never left blank by its own check. Under `bun test` (NODE_ENV=test) it throws
 * instead, so every test that builds a deck, now or later, is a test of these rules.
 */
export function reportRoomViolations(
  logger: { error: (o: object, msg: string) => void },
  key: string,
  files: Json,
  now = Date.now(),
): string[] {
  const broken = roomViolations(files);
  if (broken.length && process.env.NODE_ENV === "test")
    throw new RoomRulesBroken(`${key}: ${broken.slice(0, 5).join("; ")}`);
  if (broken.length && now - (lastLogged.get(key) ?? 0) > 60_000) {
    lastLogged.set(key, now);
    if (lastLogged.size > 1024) lastLogged.clear();
    logger.error(
      { deck: key, violations: broken.slice(0, 10), count: broken.length },
      "popcorn deck: the room would show what the host's results cannot",
    );
  }
  return broken;
}
