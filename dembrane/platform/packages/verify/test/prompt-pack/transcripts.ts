/**
 * Six synthetic Dutch table conversations for the prompt comparison pack (ECHO-1052). Every
 * place, person and organisation is invented; first names stand for nobody. Speakers are
 * not labelled, as in a real transcript: each line is one turn.
 */
export interface PackConversation {
  readonly id: string;
  /** What the participant typed as their name (a table, or a first name). */
  readonly participantName: string;
  /** A synthetic address, to show what the old Verify prompt sent and the new one drops. */
  readonly participantEmail: string | null;
  readonly what: string;
  readonly transcript: string;
}

export const DUTCH_PROJECT = {
  name: "Toekomst van Lindenwijk (fictief)",
  language: "nl",
  context:
    "Bewonersavond in de fictieve wijk Lindenwijk. Vraag aan de tafels: wat moet er de komende vijf jaar veranderen aan verkeer, groen en ontmoeten in de wijk?",
  keyTerms: "Lindenwijk, Lindenpad, buurthuis De Vonk, Kastanjeplein",
  templateKey: "event",
} as const;

export const DUTCH_CONVERSATIONS: readonly PackConversation[] = [
  {
    id: "nl-1-dominant",
    participantName: "Tafel 3",
    participantEmail: "tafel3.lindenwijk@example.org",
    what: "One voice holds about 60% of the talk; one clear minority view",
    transcript: [
      "Nou, ik zal maar beginnen, want ik woon hier al tweeëndertig jaar en ik heb alles zien veranderen.",
      "Het grootste probleem is gewoon het parkeren. Als je om zes uur thuiskomt is er op het Lindenpad geen plek meer, en dan sta je twee straten verder. Dat kan toch niet de bedoeling zijn. Er moeten meer parkeerplaatsen komen, desnoods op het Kastanjeplein, dat plein wordt toch amper gebruikt.",
      "Mm.",
      "En dan die fietsstraat die ze willen, daar word ik echt niet vrolijk van. Dan haal je nog meer plekken weg. Mijn buurvrouw is slecht ter been, die moet met de auto voor de deur kunnen komen. Dat zeg ik niet alleen voor mezelf.",
      "Ja, voor mensen die slecht ter been zijn moet het wel kunnen.",
      "Precies. En ik heb het ook aan de mensen van de flat gevraagd, en die zeggen allemaal hetzelfde: meer parkeren. Dus ik denk dat we dat gewoon als tafel moeten opschrijven.",
      "Ik wil wel iets anders zeggen. Ik heb geen auto, en voor mij is het Kastanjeplein juist de enige plek waar mijn kinderen kunnen spelen. Als daar een parkeerterrein komt, dan zijn we dat kwijt.",
      "Ja maar dat plein is leeg, daar speelt niemand.",
      "Op woensdagmiddag wel. En in de zomer ook 's avonds. Ik denk dat we eerder minder auto's in de wijk moeten hebben, niet meer plekken.",
      "Nou, dat is dan jouw mening. Ik denk dat de meeste mensen hier anders over denken. Kijk, als je kinderen hebt snap ik het, maar er moet ook gewoon geparkeerd kunnen worden. En de bus rijdt na zeven uur niet meer, dus zonder auto kom je nergens.",
      "Die bus, dat is wel waar, die rijdt veel te weinig.",
      "Dus ik zeg: parkeren op het plein, en de fietsstraat niet doen. En de bus vaker laten rijden, dat ook.",
      "Ik blijf erbij dat het plein moet blijven zoals het is.",
      "Goed, dat schrijven we dan ook op, maar ik denk dat het merendeel voor parkeren is.",
      "Kunnen we het ook over het buurthuis hebben? De Vonk is nu alleen open op dinsdag.",
      "Dat is ook zo'n ding. Vroeger was daar elke dag wat. Nu zit er niemand meer. Maar goed, het parkeren is het belangrijkste, dat staat voorop.",
    ].join("\n"),
  },
  {
    id: "nl-2-quiet-dissent",
    participantName: "Tafel 5",
    participantEmail: null,
    what: "Broad agreement; one quiet, unresolved doubt said once",
    transcript: [
      "Dus we zijn het erover eens dat er meer groen moet komen langs het Lindenpad.",
      "Ja, absoluut. Bomen, en misschien van die geveltuintjes.",
      "Geveltuinen zijn mooi, dat zie je in andere wijken ook.",
      "En de gemeente zou de eerste planten kunnen betalen, dan doen wij het onderhoud.",
      "Dat lijkt me een goed plan. Iedereen wil wel een stukje groen voor de deur.",
      "Ja. En als we dan ook nog een paar bankjes neerzetten, dan wordt het echt een straat waar je wil zijn.",
      "Ik weet het niet zeker, of iedereen dat onderhoud wel kan. Mijn moeder kan dat niet meer.",
      "Nou, dan helpt de buurman toch.",
      "Ja, dat lossen we wel op met elkaar.",
      "Oké.",
      "En de bomen, welke soort? Lindes natuurlijk, het heet niet voor niets Lindenwijk.",
      "Haha, ja, lindes. Al geven die wel van dat plakkerige spul op je auto.",
      "Dat moeten we dan maar voor lief nemen.",
      "Dus samengevat: groen, geveltuinen, bankjes, en wij doen het onderhoud. Iedereen akkoord?",
      "Ja.",
      "Ja, prima.",
      "Mm-hm.",
    ].join("\n"),
  },
  {
    id: "nl-3-once-matters",
    participantName: "Tafel 1",
    participantEmail: null,
    what: "A point mentioned once, in passing, that matters",
    transcript: [
      "Wat ik vooral mis is een plek om elkaar te ontmoeten. Het buurthuis is bijna altijd dicht.",
      "Ja, De Vonk zou vaker open moeten. Een koffieochtend, een klusmiddag, dat soort dingen.",
      "Er zijn genoeg mensen die dat zouden willen organiseren, denk ik. Het gaat vooral om de sleutel en wie verantwoordelijk is.",
      "En de verwarming, die werkt daar ook niet goed. In de winter zit je er in je jas.",
      "Ik kom zelf trouwens bijna niet meer buiten, sinds de lift in flat B al drie weken kapot is. Vierde verdieping, met mijn knie. Maar goed, het buurthuis dus.",
      "Ja, het buurthuis. Misschien kunnen we een rooster maken, met vrijwilligers.",
      "En een prikbord, of een appgroep, zodat mensen weten wanneer er wat is.",
      "Een appgroep werkt niet voor iedereen. Mijn vader heeft geen smartphone.",
      "Dan allebei, een prikbord in de hal van de flats en een appgroep.",
      "En misschien één keer per maand een maaltijd. Dat trekt altijd mensen.",
      "Ja, samen eten, dat werkt.",
      "Wie zou dat moeten betalen?",
      "Iedereen een paar euro, en de rest uit het wijkbudget, als dat er is.",
    ].join("\n"),
  },
  {
    id: "nl-4-mixed-language",
    participantName: "Tafel 7",
    participantEmail: null,
    what: "Dutch and English mixed",
    transcript: [
      "Sorry, my Dutch is not so good, is it okay if I speak English?",
      "Ja hoor, geen probleem, we switchen wel.",
      "So what I notice is that the street lights on the Lindenpad are really dark at night. I don't feel safe walking home from the tram.",
      "Ja, dat herken ik. Vooral bij het bruggetje, daar is het echt donker.",
      "And also the bike parking at the station is always full, so people leave their bikes everywhere on the sidewalk.",
      "Dat is waar, en dan kun je er met een kinderwagen niet langs.",
      "Maybe more racks near the Kastanjeplein? There is space there.",
      "Ik vind het plein eigenlijk te mooi voor fietsenrekken. Misschien langs de zijkant.",
      "Yes, on the side, that's fine.",
      "En die verlichting, dat is gewoon een kwestie van melden bij de gemeente, toch?",
      "I did report it, twice, through the app. Nothing happened.",
      "Oh. Dan moeten we dat misschien samen doen, als wijk, dan heeft het meer effect.",
      "That would be great. I can share the screenshots of my reports.",
    ].join("\n"),
  },
  {
    id: "nl-5-seventy-seconds",
    participantName: "Tafel 2",
    participantEmail: null,
    what: "A 70-second recording",
    transcript: [
      "We hebben maar kort, dus: wat is voor jullie het belangrijkste?",
      "Veiliger oversteken bij de school. Daar rijden ze echt te hard.",
      "Ja, een zebrapad, of zo'n drempel.",
      "En meer prullenbakken, er ligt overal zwerfafval op het Kastanjeplein.",
      "Oké, dus oversteken bij de school en prullenbakken. Nog iets?",
      "Nee, dit is het wel voor nu.",
    ].join("\n"),
  },
  {
    id: "nl-6-working-session",
    participantName: "Werkgroep groen",
    participantEmail: null,
    what: "A working session with explicit actions and owners",
    transcript: [
      "Oké, laten we de acties even rondmaken, want we hebben nog tien minuten.",
      "Eén: de plantdag op het Lindenpad. Sanne, jij zou de datum met de gemeente afstemmen?",
      "Ja, dat doe ik. Ik bel maandag en ik stel zaterdag twaalf april voor.",
      "Twee: de flyer voor de buren. Wie pakt dat op?",
      "Ik maak de tekst, Joost doet de opmaak, toch Joost?",
      "Ja, prima, ik heb hem vrijdag klaar.",
      "Drie: het gereedschap. We hebben twintig schoppen nodig, en kruiwagens.",
      "Daar heb ik geen idee van. Misschien kan het buurthuis dat lenen?",
      "Dat zoeken we nog uit, dat zet ik als open punt.",
      "En vier, iemand zei vorige keer dat we ook een watergeefrooster moesten maken voor de zomer.",
      "Dat lijkt me verstandig, maar laten we dat na de plantdag doen.",
      "Afgesproken. Dus: Sanne de datum, maandag. Tekst flyer door mij, opmaak Joost, vrijdag. Gereedschap open. Watergeefrooster na de plantdag.",
      "Moeten we ook niet met de woningcorporatie praten over de geveltuinen bij de flats?",
      "Goed punt, maar niemand heeft daar nu tijd voor, toch? Laten we het volgende keer bespreken.",
    ].join("\n"),
  },
];
