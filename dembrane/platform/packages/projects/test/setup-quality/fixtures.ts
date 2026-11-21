/**
 * Six realistic setup inputs for the quality check (run.ts): three Dutch municipal
 * sessions, one healthcare session, one English workshop and one pasted agenda full of
 * names and abbreviations. People and some organisations are invented.
 */
export interface QualityFixture {
  readonly id: string;
  readonly template_key: "conversation" | "series" | "event" | "upload" | "blank";
  readonly language: string;
  readonly name: string;
  readonly description: string;
  readonly source_text: string;
  readonly existing_key_terms: readonly string[];
}

export const FIXTURES: readonly QualityFixture[] = [
  {
    id: "nl-strijp-bewonersavond",
    template_key: "event",
    language: "nl",
    name: "Bewonersavond Strijp-S",
    description:
      "Bewonersavond over het warmtenet in Strijp-S, gemeente Eindhoven. We verwachten zo'n 60 bewoners aan 12 tafels. Wethouder Marieke de Wolf opent, daarna praten bewoners met Woonbedrijf, Ennatuurlijk en de VvE Strijp-R. Iedere tafel moet aan het eind de afspraken bevestigen.",
    source_text: "",
    existing_key_terms: [],
  },
  {
    id: "nl-utrecht-omgevingsvisie",
    template_key: "series",
    language: "nl",
    name: "Omgevingsvisie Leidsche Rijn",
    description:
      "Vier gesprekken met de wijkraad Leidsche Rijn en ondernemersvereniging OLR over de omgevingsvisie 2040 van de gemeente Utrecht. Thema's: Leidsche Rijn Centrum, de Maximabrug, het Máximapark en de busbaan langs de Vleutenseweg. Gespreksleider is Jeroen Ploeg van bureau Stadkwadraat. Na elk gesprek willen we de afspraken laten bevestigen.",
    source_text: "",
    existing_key_terms: ["Leidsche Rijn"],
  },
  {
    id: "nl-tilburg-reeshof",
    template_key: "conversation",
    language: "nl",
    name: "Wijkgesprek Reeshof",
    description:
      "Een gesprek met bewoners uit de Reeshof (Tilburg) over het Wijkplan Reeshof 2030. Aanwezig: de wijkregisseur, Contour de Twern en twee leden van het bewonersplatform BPR. We willen weten wat er speelt rond het Wagnerplein en de groenstrook bij de Bredaseweg.",
    source_text: "",
    existing_key_terms: [],
  },
  {
    id: "nl-zorg-clientenraad",
    template_key: "series",
    language: "nl",
    name: "Cliëntenraad Zorggroep Elde",
    description:
      "Gespreksreeks met de cliëntenraad van Zorggroep Elde over de nieuwe dagbesteding in woonzorgcentrum De Linde in Boxtel. Onderwerpen: de Wlz-indicatie, het ECD (ONS van Nedap), de rol van de specialist ouderengeneeskunde en samenwerking met huisartsenpraktijk Kalksheuvel. Voorzitter is Hanneke Verbeek.",
    source_text: "",
    existing_key_terms: ["Zorggroep Elde"],
  },
  {
    id: "en-camden-workshop",
    template_key: "event",
    language: "en",
    name: "Kentish Town healthy streets workshop",
    description:
      "A two-hour community workshop with Camden Council and the NHS North Central London ICB about the Low Traffic Neighbourhood (LTN) trial on Leighton Road and Torriano Avenue. About 40 residents at 8 tables. Facilitated by Priya Raman from Kentish Town Community Centre (KTCC). We want each table to agree on three asks.",
    source_text: "",
    existing_key_terms: [],
  },
  {
    id: "nl-agenda-pasted",
    template_key: "event",
    language: "nl",
    name: "Regiotafel Energie MRE",
    description: "Regiotafel van de Metropoolregio Eindhoven over de RES. Ik plak de agenda.",
    source_text: `AGENDA REGIOTAFEL ENERGIE, 14 november, Evoluon Eindhoven

19.00 Inloop met koffie
19.30 Welkom door dagvoorzitter Sanne Kuijpers (MRE)
19.40 Stand van zaken RES 2.0 en het RES-bod, door Tom Hendriks (programmamanager RES MRE)
20.00 Pitch: Energiecoöperatie Zon op Kempen (ZoK), Brainport Development, Enexis Netbeheer
20.20 Tafelgesprekken in drie rondes:
      - netcongestie en de wachtrij bij TenneT
      - zon op dak: SDE++ en de postcoderoos
      - warmte: TVW's en de Wijkuitvoeringsplannen (WUP)
21.15 Plenaire terugkoppeling, met wethouder Bas van der Linden (gemeente Veldhoven)
21.30 Borrel

Aanwezig: gemeenten uit de MRE, ZLTO, Brabantse Milieufederatie (BMF), provincie Noord-Brabant, Woonbedrijf, Wooninc.`,
    existing_key_terms: [],
  },
];
