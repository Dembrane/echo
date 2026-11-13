/**
 * Five synthetic source sets for the digest quality check (run.ts), as a host would drop
 * them: text the browser extracted from their files, pasted text and a link. Every person,
 * organisation, street and programme is invented.
 */
export interface DigestFixture {
  readonly id: string;
  readonly language: string;
  readonly sources: readonly {
    name: string;
    kind: "file" | "text" | "url";
    text?: string;
    url?: string;
  }[];
  /** What a linked page reads as, by URL. */
  readonly pages?: Readonly<Record<string, string>>;
  /** What a host would expect, for reading the output against. */
  readonly expect: string;
}

const POLICY_FILLER = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Artikel ${i + 1}. De begroting van het Waterschap Lindeloop wordt jaarlijks vastgesteld. Kosten voor onderhoud van kades, gemalen en stuwen worden verdeeld volgens de kostentoedelingsverordening. Deze paragraaf bevat geen bepalingen over participatie.`,
  ).join("\n");

export const DIGEST_FIXTURES: readonly DigestFixture[] = [
  {
    id: "nl-bewonersavond-uitnodiging-agenda",
    language: "nl",
    sources: [
      {
        name: "uitnodiging-bewonersavond.pdf",
        kind: "file",
        text: `Uitnodiging bewonersavond Kanaalzone-Oost

Beste bewoner,

Gemeente Veldhoven-Noord en woningcorporatie Thuisbasis nodigen je uit voor een bewonersavond over de herinrichting van de Kanaalzone-Oost. Samen met jou willen we weten wat goed gaat in de buurt en wat er anders moet aan de nieuwe groenstrook langs de Sluisweg.

Datum: donderdag 4 december
Tijd: 19.30 tot 21.30 uur, inloop vanaf 19.00
Locatie: Wijkcentrum De Schakel, Sluisweg 12

Aanmelden kan bij Ilse Verbeek, i.verbeek@thuisbasis.example of 06-41234567.
Parkeren kan op het plein achter het wijkcentrum.`,
      },
      {
        name: "agenda.docx",
        kind: "file",
        text: `Agenda bewonersavond Kanaalzone-Oost
19.30 Welkom door wethouder Ramon Dijkhuis
19.45 Ronde 1: Wat gaat goed in de Kanaalzone-Oost?
20.20 Pauze
20.35 Ronde 2: Wat moet anders aan de groenstrook langs de Sluisweg?
21.10 Terugkoppeling per tafel en vervolg door projectleider Saskia Holtrop (Thuisbasis)
21.30 Afsluiting`,
      },
    ],
    expect:
      "resident_evening, rounds as tags, Kanaalzone-Oost, Sluisweg, Thuisbasis, De Schakel; no e-mail or phone in the context",
  },
  {
    id: "nl-strategiedag-slides",
    language: "nl",
    sources: [
      {
        name: "strategiedag-2027.pptx",
        kind: "file",
        text: `Strategiedag Zorggroep Oeverland 2027
Koers 2030: samen dichtbij

Programma
09.00 Opening door bestuurder Joost Ammerlaan
09.30 Waar staan we? Terugblik op het programma Thuis Eerst
10.30 Werksessies in vier groepen: personeel, digitale zorg, wijkteams, financiën
13.00 Lunch
14.00 Keuzes maken: welke drie prioriteiten voor 2027?
16.00 Afsluiting en vervolgafspraken

Speaker notes: Vraag elke groep om aan het eind drie concrete acties te noemen. De OR en de cliëntenraad zijn erbij.`,
      },
    ],
    expect:
      "strategy_day, tags for the work sessions or day parts, Thuis Eerst, Zorggroep Oeverland, OR",
  },
  {
    id: "en-interview-guide",
    language: "en",
    sources: [
      {
        name: "interview-guide.docx",
        kind: "file",
        text: `Interview guide: carers' experience of respite services
Project: Northfold Carers Voice, run with the Harrowgate Community Health Partnership (HCHP)

Introduction (5 min): explain consent, recording and that answers are anonymised.
1. Can you tell me about a typical week caring for your relative?
2. Which respite services have you used, such as the Ashbourne Day Centre or the Sitting Service?
3. What made it easy or hard to get support?
4. If you could change one thing about respite in Northfold, what would it be?
Closing: thank the participant and explain next steps.

Interviewers: Priya Raman, Tom Ellery`,
      },
    ],
    expect: "interviews, explore prompt from the four questions, HCHP, Ashbourne Day Centre",
  },
  {
    id: "en-workshop-brief-with-link",
    language: "en",
    sources: [
      {
        name: "Pasted text",
        kind: "text",
        text: `Workshop brief. Fernhill Library Futures: a half-day workshop with library staff, volunteers and two youth panels to imagine the library in 2035. We will use rotating tables. Questions: What should the library offer that nobody else does? Who is missing today? Contact the organiser at futures@fernhill.example.`,
      },
      { name: "fernhill.example/futures", kind: "url", url: "https://fernhill.example/futures" },
    ],
    pages: {
      "https://fernhill.example/futures":
        "Fernhill Library Futures. Saturday 17 January at the Old Mill Room, Fernhill Central Library. Facilitated by the Brightwater Collective.",
    },
    expect:
      "world_cafe or futures, Fernhill Library Futures, Brightwater Collective; no e-mail in the context",
  },
  {
    id: "nl-lange-beleidsnota-een-pagina",
    language: "nl",
    sources: [
      {
        name: "beleidsnota-waterschap.pdf",
        kind: "file",
        text: `${POLICY_FILLER(40)}

Pagina 7. Participatie Dommeldal-Zuid
Het Waterschap Lindeloop organiseert op 22 januari een werksessie met agrariërs, natuurorganisatie Stichting Beekdal en bewoners van Hoogeloon over het peilbesluit Dommeldal-Zuid. Centrale vragen: Hoe gaan we om met droogte in de zomer? Welke maatregelen zijn haalbaar voor boeren? De sessie duurt een dagdeel en wordt geleid door Annelies Groenveld.

${POLICY_FILLER(40)}`,
      },
    ],
    expect:
      "one session from page 7 only: Dommeldal-Zuid, Stichting Beekdal, Hoogeloon, peilbesluit; the filler ignored",
  },
];
