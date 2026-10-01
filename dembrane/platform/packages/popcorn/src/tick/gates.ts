import { popcornShared } from "@dembrane/analysis";
import { dict, type Json, list, orStr, pyStr } from "../py";
import { pySplit, pyStrip } from "../text";
import { pyRepr, W, WB_END, WB_START } from "./util";

/**
 * Deterministic gates on the two analysis slides, sent back to the model once (popcorn
 * gates.py): one group per stakeholder card and the group is people, one connected map,
 * and every line of a tension readable in one glance. Word boundaries are Python's
 * Unicode ones, so the gates flag the same names in every language.
 */

// A comma joins two groups when a second name follows it; a qualifier after it is one group.
const JOINED_WORDS = new RegExp(`(${WB_START}and${WB_END}|&|/)`, "iu");
const JOINED_COMMA = /,\s*[A-ZÀ-Þ]/u;
const PEOPLE = new RegExp(
  `${WB_START}(people|persons?|staff|workers?|users?|members?|residents?|volunteers?|developers?|hosts?` +
    "|facilitators?|leaders?|managers?|teams?|citizens?|participants?|women|men|youth|parents?" +
    "|students?|employees?|customers?|clients?|partners?|funders?|commissioners?|officials?|experts?" +
    "|practitioners?|newcomers?|colleagues?|organisations?|organizations?|charities|charity|groups?" +
    `|communit(y|ies)|neighbou?rs?|families|family|founders?|owners?|directors?|board|councils?|makers?)${WB_END}`,
  "iu",
);
const THING = new RegExp(
  `${WB_START}(tool|tools|system|systems|technology|software|platform|app|recording|recordings|algorithm` +
    "|ai|bot|machine|summary|dashboard|black box" +
    "|pressure|pressures|demand|demands|force|forces|factor|factors|trend|trends|process|processes" +
    "|structure|structures|culture|cultures|market|markets|environment|environments)$",
  "iu",
);

export const { components, KNOT_WORDS, POLE_MIN_WORDS, POLE_WORDS, QUESTION_WORDS } = popcornShared;
const SENTENCE_END = /[.!?](\s|$)/gu;
const MEETING = new RegExp(
  `${WB_START}(participants?|attendees|the (group|room|team) (discussed|recognised|recognized|acknowledged` +
    `|expressed|felt|noted)|discussed|recognis${W}+|recogniz${W}+|acknowledg${W}+` +
    `|express${W}+ (concern|a desire|the need)|feel(s|ing)? that|felt that)${WB_END}`,
  "iu",
);

const words = (s: unknown) => pySplit(orStr(s)).length;

/** One group, one name, and the group is people. */
export function nameFlags(stake: Json): string[] {
  const flags: string[] = [];
  for (const raw of list(stake.stakeholders)) {
    const g = dict(raw);
    const name = orStr(g.name);
    const gid = "id" in g ? g.id : "?";
    if (JOINED_WORDS.test(name) || JOINED_COMMA.test(name))
      flags.push(
        `${pyStr(gid)}: ${pyRepr(name)} joins two groups on one card; one group, one name`,
      );
    else if (THING.test(pyStrip(name)) && !PEOPLE.test(name))
      flags.push(
        `${pyStr(gid)}: ${pyRepr(name)} names a thing, not people; name the people who make or run it`,
      );
  }
  return flags;
}

/** One connected map, no group without a relation. */
export function islandFlags(stake: Json): string[] {
  const names = new Map(
    list(stake.stakeholders).map((g) => [pyStr(dict(g).id), dict(g).name ?? dict(g).id]),
  );
  const comps = components(stake);
  if (comps.length <= 1) return [];
  comps.sort((a, b) => b.length - a.length);
  return comps.slice(1).map((comp) => {
    if (comp.length === 1) {
      const g = comp[0] as string;
      return `${g}: ${pyRepr(names.get(g))} has no relation to any other group; add the relation the transcripts support, or drop the group`;
    }
    return `island: ${comp.map((g) => `${g} ${pyRepr(names.get(g))}`).join(", ")} connect only to each other; add the relation that joins them to the rest, or drop them`;
  });
}

/** Every line of a tension lands in one glance from the back of the room. */
export function screenFlags(tensions: Json): string[] {
  const flags: string[] = [];
  for (const raw of list(tensions.tensions)) {
    const t = dict(raw);
    const tid = pyStr("id" in t ? t.id : "?");
    for (const pole of ["poleA", "poleB"]) {
      const n = words(t[pole]);
      if (n > POLE_WORDS)
        flags.push(`${tid} ${pole}: ${n} words, at most ${POLE_WORDS}: ${pyRepr(t[pole])}`);
      else if (n < POLE_MIN_WORDS)
        flags.push(`${tid} ${pole}: ${n} words, at least ${POLE_MIN_WORDS}: ${pyRepr(t[pole])}`);
    }
    const knot = orStr(t.knot);
    if (!knot) flags.push(`${tid} knot: missing`);
    else if (words(knot) > KNOT_WORDS)
      flags.push(`${tid} knot: ${words(knot)} words, at most ${KNOT_WORDS}: ${pyRepr(knot)}`);
    else if ((pyStrip(knot).match(SENTENCE_END) ?? []).length > 1)
      flags.push(`${tid} knot: more than one sentence: ${pyRepr(knot)}`);
    if (!pyStrip(orStr(t.toResolve))) flags.push(`${tid} toResolve: missing`);
    else if (words(t.toResolve) > QUESTION_WORDS)
      flags.push(
        `${tid} toResolve: ${words(t.toResolve)} words, at most ${QUESTION_WORDS}: ${pyRepr(t.toResolve)}`,
      );
    for (const field of ["knot", "toResolve"]) {
      const m = MEETING.exec(orStr(t[field]));
      if (m)
        flags.push(`${tid} ${field}: reports the meeting (${pyRepr(m[0])}): ${pyRepr(t[field])}`);
    }
  }
  return flags;
}
