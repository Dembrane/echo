#!/usr/bin/env bun
/**
 * Writes the Millbrook sample's conversations, report and chat (fixtures/millbrook) with
 * Gemini, from the scenario in project.json and the briefs below. Every name, street and
 * quote is invented here, so the fixture carries nothing from a real project. The output is
 * checked in; the migrate job only reads it, so a preview never calls a model.
 *
 *   LLM_VERTEX_PROJECT=dembrane-echo bun packages/samples/scripts/generate-millbrook.ts
 *   ... generate-millbrook.ts --report-only   keep the conversations, rewrite report and chat
 *
 * Model, project and location come from the llm config section like every other caller
 * (LLM_VERTEX_LOCATION defaults to eu, the EU residency endpoint). A rerun replaces all
 * three files; the seed then puts the new text on every preview at its next deploy.
 */
import path from "node:path";
import { loadSections } from "@dembrane/config";
import { type Completer, createModels, vertexCompleter } from "@dembrane/llm";

const dir = path.resolve(import.meta.dir, "../fixtures/millbrook");
const project = (await Bun.file(path.join(dir, "project.json")).json()) as {
  context: string;
  language: string;
};
const out = (s: string) => process.stdout.write(`${s}\n`);

const TOWN = `Millbrook is a fictional market town of about 18,000 people on the River Mell. Money is in euros.
The town's gas network will be retired in 2035; Millbrook Town Council runs this assembly to advise on what replaces it.
Options on the table: individual heat pumps, a shared heat network (one idea draws heat from the River Mell next to the old paper mill site), insulation first, electric heating, and a lot of doubt about hydrogen.
Places to use (all invented): Quarry Row and Osier Street (Victorian terraces), Hopfield Road (1930s semis), Linden Terrace (bungalows for older residents), the Kestrel Estate with its twelve-storey Heron Tower (council housing, one communal boiler), Canal Wharf (converted warehouse flats, leaseholders), Market Square and Tanner's Walk (shops with flats above), St Aldric's Yard (stone cottages in the conservation area), Thornby Hollow (a hamlet off the gas grid, oil and wood), Weavers' Hall (community centre), the Mell Valley leisure centre and its pool, Larkspur Lodge (a care home), Millbrook College.
Day 1 is 2 July 2026 in the Weavers' Hall, with tables in the room and online rooms; Day 2 is 3 July.`;

interface Brief {
  readonly key: string;
  readonly name: string;
  readonly started_at: string;
  readonly chunks: number;
  readonly brief: string;
}

// Keys stay as they were so conversation ids stay stable and a preview's rerun overwrites
// its old rows instead of adding a second set.
const BRIEFS: readonly Brief[] = [
  {
    key: "table-1",
    name: "Table 1",
    started_at: "2026-07-02T07:32:00Z",
    chunks: 42,
    brief:
      "A table in the hall. Priya (district nurse, owns a 1930s semi on Hopfield Road), Gareth (retired postman, terrace on Quarry Row since 1991), Wren (student renting a room), Farid (runs the corner shop on Osier Street, lives above it), Beatrix (retired bookkeeper), and facilitator Tobias. Theme: who goes first. Gareth wants to wait until prices fall, Priya cannot afford to be an early adopter, Farid worries about his freezers. They land on the idea of doing a whole street at once with a neighbour buddy scheme, but disagree about whether it should be voluntary.",
  },
  {
    key: "table-2",
    name: "Table 2",
    started_at: "2026-07-02T07:34:00Z",
    chunks: 42,
    brief:
      "A table in the hall. Callum (owns four rented terraces on Osier Street), Tamsin (private renter, damp flat, black mould in the bedroom), Obi (works at a letting agency), Hedda (retired owner-occupier) and facilitator Meera. Theme: the split incentive. Callum says a heat pump costs him and saves the tenant; Tamsin says the cost of doing nothing already lands on her health. Sharp exchanges. Conditions: grants for landlords only with a rent freeze attached; Callum rejects that.",
  },
  {
    key: "table-3",
    name: "Table 3",
    started_at: "2026-07-02T07:36:00Z",
    chunks: 41,
    brief:
      "A table in the hall. Rafael (process engineer who worked at the paper mill before it closed), Nell (runs the community choir), Imogen (parent of two toddlers, Hopfield Road), Bartek (self-employed plumber) and facilitator Tobias. Theme: the River Mell heat network. Rafael is enthusiastic about river-source heat; Bartek fears being locked into one supplier's tariff with no way out; Imogen asks what happens during the years of digging. Conditions: community or council ownership, a published price cap, and a right to leave.",
  },
  {
    key: "table-4",
    name: "Table 4",
    started_at: "2026-07-02T07:38:00Z",
    chunks: 34,
    brief:
      "A smaller table of younger residents. Juno (17, at Millbrook College), Kai (22, apprentice electrician), Mira (29, rents a flat with her partner on Tanner's Walk) and facilitator Meera. Theme: fairness between generations and jobs. Kai sees work for years; Juno is angry decisions were delayed; Mira doubts she will ever own anything to insulate. Some apathy and jokes, then a serious point about training places at the college.",
  },
  {
    key: "table-5",
    name: "Table 5",
    started_at: "2026-07-02T07:40:00Z",
    chunks: 42,
    brief:
      "A table in the hall. Winifred (84, widow, bungalow on Linden Terrace), her son Desmond (came to help her), Anjali (receptionist at the GP surgery), Hugo (retired electrical engineer, sceptical that heat pumps keep old people warm enough) and facilitator Lin. Theme: comfort, health and trust. Winifred was once targeted by a doorstep insulation scam; Anjali describes patients who ration heating; Hugo and Anjali disagree on radiator temperatures. Condition: one trusted local advice point, no cold calling.",
  },
  {
    key: "table-6",
    name: "Table 6",
    started_at: "2026-07-02T07:42:00Z",
    chunks: 42,
    brief:
      "A table of Heron Tower residents on the Kestrel Estate. Sadia (tenant on the ninth floor, three children), Leon (tenant, works nights), Marguerite (leaseholder who bought under right to buy) and facilitator Lin. Theme: the communal boiler. The heating goes on and off by calendar date, not weather; everyone pays a flat charge whatever they use. Marguerite fears a big bill as leaseholder; Sadia wants control of her own flat. They want to be consulted before the landlord picks a system.",
  },
  {
    key: "table-7",
    name: "Table 7",
    started_at: "2026-07-02T07:44:00Z",
    chunks: 40,
    brief:
      "A table of shopkeepers from Market Square and Tanner's Walk who live above their shops. Rosalind (café owner), Emeka (barber), Stan (butcher, cold rooms) and facilitator Tobias. Theme: mixed-use buildings. No yard for an outdoor unit, shopfronts in a row, cannot close for a week of works. Stan's refrigeration already dumps heat he would love to reuse. Condition: works scheduled around trading and a business rate relief during disruption.",
  },
  {
    key: "table-8",
    name: "Table 8",
    started_at: "2026-07-02T07:46:00Z",
    chunks: 43,
    brief:
      "A table in the hall. Solveig (mortgage adviser), Declan (self-employed builder), Ama (primary teacher, owns a terrace on Quarry Row) and Pim (pensioner, mortgage paid off) with facilitator Meera. Theme: who pays and how. Loans tied to the house versus grants; Pim says a loan at 76 is just a bill he will leave his daughter. Declan warns that cheap work gets done badly. They disagree about means testing.",
  },
  {
    key: "online-room-1",
    name: "Online Room 1",
    started_at: "2026-07-02T07:36:00Z",
    chunks: 37,
    brief:
      "An online room for residents who could not come in person. Tariq (bus driver on shifts), Bryony (single parent, joins from her kitchen with a child interrupting), Lucía (works two part-time jobs) and online facilitator Odile. Some connection trouble and muted microphones. Theme: time. Nobody has time to compare quotes or wait in for surveyors. They want a single place that does the paperwork and one appointment, not five.",
  },
  {
    key: "online-room-2",
    name: "Online Room 2",
    started_at: "2026-07-02T07:38:00Z",
    chunks: 38,
    brief:
      "An online room. Morwenna (carer for her adult son who uses a home ventilator), Isaac (wheelchair user in a ground-floor flat on Canal Wharf), Rhoda (lives alone with chronic pain, cold makes it worse) and online facilitator Odile. Theme: disability and power. Power cuts, works that block access, and heating that must never fail. Isaac asks who checks installers understand accessibility. Condition: a priority register and a backup plan before anyone switches off gas.",
  },
  {
    key: "online-room-3",
    name: "Online Room 3",
    started_at: "2026-07-02T07:40:00Z",
    chunks: 33,
    brief:
      "An online room. Eun-ji (software tester, works from home, has an electric car), Fergus (commutes to the city, rarely home in daytime), Anneke (retired, keen on smart meters) and online facilitator Lin. Theme: the electricity grid. If every house on a street gets a heat pump and a car charger, can the cables cope? Time-of-use tariffs: Anneke likes them, Fergus finds them a trap for people who cannot shift their day.",
  },
  {
    key: "plenary-day-1-close",
    name: "Plenary, Day 1 close",
    started_at: "2026-07-02T10:00:00Z",
    chunks: 46,
    brief:
      "The closing plenary of Day 1 in the Weavers' Hall. Lead facilitator Odile invites one reporter per table to give the table's headline in a minute, including the online rooms; residents interrupt to correct or add. Draw on the themes of the other briefs: first movers, the split incentive, the River Mell heat network conditions, the communal boiler in Heron Tower, shops with flats above, who pays, time, disability and power, the grid. Odile records disagreements on purpose instead of merging them and ends with the open questions for Day 2.",
  },
  {
    key: "table-9",
    name: "Table 9",
    started_at: "2026-07-02T07:34:00Z",
    chunks: 50,
    brief:
      "A table of Canal Wharf leaseholders. Esther (retired, first floor), Vikram (young couple, bought last year), Poppy (runs a design studio from her flat) and facilitator Tobias. Theme: the freeholder decides, the leaseholders pay. Service charges already doubled; shared walls and one roof mean nobody can act alone. Fear of a major works bill in the tens of thousands. They want a legal duty on freeholders to consult and a cap on what can be charged per flat.",
  },
  {
    key: "table-10",
    name: "Table 10",
    started_at: "2026-07-02T07:36:00Z",
    chunks: 44,
    brief:
      "A table of Thornby Hollow residents, off the gas grid. Aled (sheep farmer), Greta (runs two holiday cottages), Rufus (retired teacher who heats with wood) and facilitator Lin. Theme: we were never on the gas network. Oil deliveries, a single overhead power line that fails in storms, wood smoke. They feel the assembly is about the town and not about them. Condition: grid reinforcement before anyone asks them to electrify.",
  },
  {
    key: "table-11",
    name: "Table 11",
    started_at: "2026-07-02T07:38:00Z",
    chunks: 43,
    brief:
      "A table of community and faith groups. Pastor Joy (the Methodist chapel), Yusuf (volunteer at the mosque on Osier Street), Clem (runs the scout hut) and facilitator Meera. Theme: big buildings used a few hours a week, and people who never come to consultations. Heating a chapel for two hours on Sunday; the mosque is busy five times a day. They offer their buildings as places to reach residents the council never hears from.",
  },
  {
    key: "table-12",
    name: "Table 12",
    started_at: "2026-07-02T07:40:00Z",
    chunks: 45,
    brief:
      "A table of young renters. Zara (nurse, shares a house on Hopfield Road), Theo (barista, moves every year), Niamh (PhD student) and facilitator Tobias. Theme: renters move, upgrades stay. Why should they care about a house they will leave next spring? They want energy ratings enforced, a portable warm-home credit that moves with the tenant, and a way to report a cold home without being evicted.",
  },
  {
    key: "online-room-4",
    name: "Online Room 4",
    started_at: "2026-07-02T07:42:00Z",
    chunks: 43,
    brief:
      "An online room with residents whose first language is not English. Agnieszka (care worker), Mehmet (runs a takeaway), Dinh (retired, joins with his granddaughter translating) and online facilitator Odile. Theme: information. Leaflets only in English, words like 'retrofit' mean nothing, trust comes through people they know. Mehmet has had bad experiences with officials. Condition: information in several languages through community groups, not only the council website.",
  },
  {
    key: "online-room-5",
    name: "Online Room 5",
    started_at: "2026-07-02T17:30:00Z",
    chunks: 43,
    brief:
      "An evening online room with residents who already switched. Harriet (heat pump for three years, loves it), Sol (solar panels and a battery), Orla (heat pump installed badly, radiators too small, first winter was miserable) and online facilitator Lin. Theme: lived experience. Harriet and Orla's stories collide; the difference was the installer and the survey. Condition: a proper heat-loss survey and a named installer who comes back.",
  },
  {
    key: "rowan-house-visit",
    name: "Care home visit",
    started_at: "2026-07-02T13:00:00Z",
    chunks: 44,
    brief:
      "Facilitators Meera and Lin visit Larkspur Lodge care home, since its residents could not come to the hall. Bernadette (the manager), Joseph (care worker on nights), residents Ivy (91) and Clarence (88). Theme: warmth as care. Rooms must stay warm day and night; residents feel cold at temperatures staff find comfortable; the home cannot be without heating for a day. Ivy remembers coal fires. Bernadette asks who pays for a care home's switch.",
  },
  {
    key: "saturday-market-pop-up",
    name: "Saturday market pop-up",
    started_at: "2026-06-27T09:30:00Z",
    chunks: 38,
    brief:
      "A pop-up stall at the Saturday market in Market Square the week before the assembly, run by facilitator Tobias. Short exchanges with passers-by: a fishmonger from the next stall, a teenager, a man walking his dog, a mother with a pram, a pensioner who thinks it is a sales pitch. Most had not heard the gas network will close. Street noise, people leaving mid-sentence. Tobias invites them to the assembly.",
  },
  {
    key: "church-lane-heritage-table",
    name: "Heritage cottages table",
    started_at: "2026-07-02T07:44:00Z",
    chunks: 47,
    brief:
      "A table of St Aldric's Yard residents in the conservation area. Perpetua (stone cottage from the 1780s), Laszlo (restorer of old windows), Hamish (bought his cottage two years ago) and facilitator Lin. Theme: heritage rules. Double glazing refused, external insulation not allowed, internal insulation risks damp in solid stone walls. Laszlo defends old windows with secondary glazing. They want clear planning guidance and a conservation officer at the table.",
  },
  {
    key: "trades-table",
    name: "Trades table",
    started_at: "2026-07-02T07:46:00Z",
    chunks: 43,
    brief:
      "A table of local tradespeople. Duncan (gas engineer for 25 years), Sunita (electrician), Craig (teaches plumbing at Millbrook College) and facilitator Meera. Theme: who does the work. Duncan fears for his livelihood and resents being cast as the problem; Sunita says half the houses need new fuse boards first; Craig has empty places on the heat pump course. Condition: paid retraining and a steady pipeline of work so small firms can plan.",
  },
  {
    key: "community-buildings-table",
    name: "Community buildings table",
    started_at: "2026-07-02T07:48:00Z",
    chunks: 47,
    brief:
      "A table about public buildings. Marjorie (trustee of Weavers' Hall), Idris (manager of the Mell Valley leisure centre and its pool), Ms Okafor (head of the primary school) and facilitator Tobias. Theme: anchors. The pool is the biggest heat user in town and could anchor the River Mell network; the school wants to show pupils; the hall has no money. Tension about whether public buildings should go first or whether homes should.",
  },
  {
    key: "facilitators-debrief-day-1",
    name: "Facilitators' debrief, Day 1",
    started_at: "2026-07-02T15:30:00Z",
    chunks: 43,
    brief:
      "The facilitation team's debrief after Day 1: Odile (lead), Meera, Tobias and Lin. What went well, which tables were hard, where they steered too much, whose voices were missing (young men, people in work, off-grid residents at first), the online rooms' technical trouble, and what to change for Day 2. Honest and a bit tired.",
  },
  {
    key: "plenary-day-2-open",
    name: "Plenary, Day 2 open",
    started_at: "2026-07-03T07:30:00Z",
    chunks: 36,
    brief:
      "Lead facilitator Odile opens Day 2 in the Weavers' Hall. She recaps the open questions from Day 1 (who carries first-mover risk, conditions on a River Mell heat network, landlords and tenants, what happens to people who cannot switch) and residents respond from the floor: a few new faces, one person who wants to skip to a vote, one who says Day 1 was a talking shop. Odile sets the agenda for the day.",
  },
];

const CHAT = {
  name: "Renters, the heat network and Day 2 questions",
  keys: [
    "table-1",
    "table-2",
    "table-3",
    "table-6",
    "table-8",
    "table-9",
    "table-12",
    "online-room-2",
    "community-buildings-table",
    "plenary-day-1-close",
    "facilitators-debrief-day-1",
    "plenary-day-2-open",
  ],
  questions: [
    "where do renters and owners split across the tables?",
    "what would it take for residents to back the River Mell heat network?",
    "which three questions should Day 2 tackle first?",
  ],
};

const CONVERSATION_SCHEMA = {
  type: "object",
  properties: {
    chunks: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["chunks", "summary"],
};

const SYNTHETIC = "Synthetic sample: an invented conversation, no real participants.";

/** The house style has no em or en dashes; the model uses them anyway. */
const clean = (t: string) =>
  t
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/, ([.,;:])/g, "$1")
    .trim();

function completer(): { c: Completer; label: string } {
  const { values } = loadSections(["llm"]);
  const groups = {
    text_fast: values.llm.textFast,
    multi_modal_fast: values.llm.multiModalFast,
    multi_modal_pro: values.llm.multiModalPro,
  };
  const models = createModels({
    vertexProject: values.llm.vertexProject,
    vertexLocation: values.llm.vertexLocation,
    groups,
    embeddingModel: values.llm.embeddingModel,
    embeddingLocation: values.llm.embeddingLocation,
    embeddingDimensions: values.llm.embeddingDimensions,
  });
  return {
    c: vertexCompleter(models, { groups }),
    label: `${groups.multi_modal_pro[0]} (${values.llm.vertexProject}, ${values.llm.vertexLocation})`,
  };
}

const system = `You write fully invented sample data for a civic listening product. ${TOWN}

Assembly brief for facilitators:
${project.context}

Rules: every person, street and organisation is fictional and from the scenario or invented by you. Never name a real company, municipality, charity or public figure. Use British English, no em dashes.`;

async function conversation(c: Completer, b: Brief) {
  const answer = await c.complete({
    group: "multi_modal_pro",
    system,
    temperature: 1,
    maxTokens: 30_000,
    jsonSchema: CONVERSATION_SCHEMA,
    timeoutMs: 300_000,
    user: `Write the automatic transcript of this conversation: "${b.name}".
${b.brief}

Transcript: exactly ${b.chunks} chunks, each about 30 seconds of speech (60 to 90 words), in order. No speaker labels: it reads like speech-to-text of a table recorder, lowercase starts, fillers (um, like, you know), false starts, people talking over each other, turns running across chunk boundaries. People introduce themselves by first name near the start. Make it specific: amounts in euros, streets, anecdotes, disagreements that stay unresolved, conditions phrased as "only if". Let each person sound different.

Summary: two or three paragraphs, 180 to 260 words, plain prose, no markdown. Say what makes this conversation distinctive, name the participants, keep disagreements and conditions intact, and quote a sharp phrase or two.`,
  });
  const parsed = JSON.parse(answer.text) as { chunks: string[]; summary: string };
  const chunks = parsed.chunks.map(clean).filter(Boolean);
  if (chunks.length < Math.min(30, b.chunks - 6))
    throw new Error(`${b.key}: only ${chunks.length} chunks`);
  return {
    key: b.key,
    name: b.name,
    origin: "generated",
    started_at: b.started_at,
    summary: `${clean(parsed.summary)}\n\n${SYNTHETIC}`,
    chunks: chunks.map((text, i) => ({ at_s: i * 30, text })),
  };
}

type Conversation = Awaited<ReturnType<typeof conversation>>;

const transcriptOf = (x: Conversation) => `## ${x.name}\n${x.chunks.map((k) => k.text).join(" ")}`;

async function report(c: Completer, all: Conversation[]) {
  const answer = await c.complete({
    group: "multi_modal_pro",
    system,
    temperature: 0.7,
    maxTokens: 20_000,
    timeoutMs: 300_000,
    user: `Here are all ${all.length} conversations of the assembly, each with its summary and transcript.

${all.map((x) => `${transcriptOf(x)}\n\nSummary: ${x.summary}`).join("\n\n")}

Write the assembly report in Markdown, 1500 to 1900 words: a "# " title, an opening paragraph, then eight to ten sections, each a "### " heading phrased as a question a council member would ask, answered in one or two dense paragraphs that name the conversations and participants and quote them. Keep disagreements and conditions intact. End with a closing paragraph and then, on its own line, exactly: *Synthetic sample: written by the report pipeline from invented conversations. No real participants.*
Use only what is in these conversations.`,
  });
  return `${clean(answer.text)}\n`;
}

async function chat(c: Completer, all: Conversation[]) {
  const picked = CHAT.keys.map((k) => {
    const x = all.find((y) => y.key === k);
    if (!x) throw new Error(`chat names ${k}, which is not a conversation`);
    return x;
  });
  const context = picked.map(transcriptOf).join("\n\n");
  const turns: { from: string; text: string }[] = [];
  for (const q of CHAT.questions) {
    const history = turns.map((t) => `${t.from}: ${t.text}`).join("\n\n");
    const answer = await c.complete({
      group: "multi_modal_pro",
      system: `${system}\n\nYou are the analysis assistant in a chat over these conversations only:\n\n${context}`,
      temperature: 0.5,
      maxTokens: 8_000,
      timeoutMs: 300_000,
      user: `${history ? `Earlier in this chat:\n${history}\n\n` : ""}Question: ${q}\n\nAnswer in 220 to 320 words of plain prose (a short numbered list is fine where the question asks for items). Name the conversations and participants you draw on and quote them. Use only these conversations.`,
    });
    turns.push({ from: "user", text: q }, { from: "assistant", text: clean(answer.text) });
  }
  return { name: CHAT.name, conversation_keys: CHAT.keys, turns };
}

async function pool<T, R>(items: readonly T[], size: number, f: (t: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await f(items[i] as T);
      }
    }),
  );
  return results;
}

// --report-only keeps the checked-in conversations and writes the report and chat again.
const reportOnly = process.argv.includes("--report-only");
const { c, label } = completer();
let all: Conversation[];
if (reportOnly) {
  all = (await Bun.file(path.join(dir, "conversations.json")).json()) as Conversation[];
  out(`keeping ${all.length} conversations; report and chat with ${label}`);
} else {
  out(`generating ${BRIEFS.length} conversations with ${label}`);
  all = await pool(BRIEFS, 5, async (b) => {
    const x = await conversation(c, b);
    out(`  ${b.key}: ${x.chunks.length} chunks`);
    return x;
  });
}
out("writing the report");
const md = await report(c, all);
out("writing the chat");
const ch = await chat(c, all);

await Bun.write(path.join(dir, "conversations.json"), `${JSON.stringify(all, null, 2)}\n`);
await Bun.write(path.join(dir, "report.md"), md);
await Bun.write(path.join(dir, "chat.json"), `${JSON.stringify(ch, null, 2)}\n`);
out(`wrote ${all.length} conversations, a report and a ${ch.turns.length}-turn chat to ${dir}`);
