---
title: Problemen met transcripten & samenvattingen oplossen
description: Wat je doet als een transcript fouten bevat, een samenvatting de kern mist, of een gesprek geen tekst, een fout of een slot laat zien.
audience: host
---

# Problemen met transcripten & samenvattingen oplossen

Bijna elk probleem is een van deze drie: het transcript bevat fouten, de samenvatting mist de
kern, of er is helemaal geen tekst. Zoek hieronder dat van jou.

| Wat je ziet | Ga naar |
|---|---|
| Namen of vaktermen zijn verkeerd gespeld, of stukken lezen slecht | 1. Het transcript bevat fouten |
| De samenvatting is vaag, gaat over iets anders of staat in de verkeerde taal | 2. De samenvatting mist de kern |
| "Wordt getranscribeerd", "Leeg", "Transcriptiefout", "Vergrendeld", of helemaal niets | 3. Er is geen transcript of samenvatting |

## 1. Het transcript bevat fouten

Je kunt de tekst van een transcript niet bewerken. Je geeft dembrane betere informatie en
laat het gesprek opnieuw transcriberen.

1. Voeg kernbegrippen toe. Open "Portaalbewerker", "Geavanceerde instellingen",
   "Kernbegrippen", of klik op "Kernbegrippen instellen" in het "Overzicht". Voeg de namen
   van mensen, plaatsen en organisaties toe, en het jargon dat verkeerd is uitgeschreven.
   Druk na elk begrip op Enter.
2. Controleer de taal. "Taal" onder "Basisinstellingen" in de portaalbewerker is een hint
   voor de transcriptie. dembrane schrijft op wat er gezegd wordt, en de hint helpt waar de
   audio ruimte laat voor twijfel.
3. Transcribeer opnieuw. Open het gesprek en klik op de ronde pijl naast de kop
   "Transcriptie", "Hertranscriptie gesprek" (Bèta). Vul "Nieuwe gespreksnaam" in en klik op
   "Hertranscriptie".

Kernbegrippen toevoegen verandert bestaande transcripten niet. Opnieuw transcriberen wel.

### Wat opnieuw transcriberen doet

- Het maakt een nieuw gesprek van dezelfde audio, met een vers transcript. Het origineel
  blijft zoals het is, en de twee verwijzen naar elkaar. Verwijder het oude gesprek zelf als
  het nieuwe goed is.
- Je ziet "Hertranscriptie gestart. Nieuw gesprek wordt binnenkort beschikbaar." Klik op "Ga
  naar nieuw gesprek".
- "Transcript anonimiseren" staat eerst op de instelling van het project. Staat het aan, dan
  kun je van het nieuwe gesprek de audio niet afspelen of downloaden, en kun je het niet nog
  een keer opnieuw transcriberen.
- "Geverifieerde artefacten toevoegen" zie je als het origineel goedgekeurde resultaten
  heeft. Zet het aan om ze naar het nieuwe gesprek te kopiëren.
- Het nieuwe gesprek telt mee voor je audio-uren, net als elk ander gesprek. In het gratis
  plan gaat er dus opnieuw een deel van je uur af.
- Een geanonimiseerd gesprek kun je niet opnieuw transcriberen.

### Tekens die je in een transcript kunt tegenkomen

| Teken | Betekenis |
|---|---|
| `[unclear]` of `[crosstalk]` | Woorden die dembrane niet kon verstaan. dembrane laat liever een stuk weg dan dat het gokt. |
| `[Nothing to transcribe]` | In dat stuk audio werd niets gezegd. Dit is geen fout. |
| `<redacted_name>` en vergelijkbare tekens | Het gesprek is geanonimiseerd en persoonsgegevens zijn vervangen. Namen die je als kernbegrip hebt opgegeven worden ook vervangen. |
| "Kan dit fragment niet verwerken" | Dat stuk audio is mislukt. Zie deel 3. |

Voor de volgende sessie: houd de telefoon dicht bij de mensen die praten en weg van
achtergrondgeluid.

## 2. De samenvatting mist de kern

Een taalmodel schrijft de samenvatting op basis van het transcript, de naam en de
"Projectcontext" van het project, de kernbegrippen, de "Paginatitel" en "Pagina-inhoud" van
het portaal, en de resultaten die een deelnemer heeft goedgekeurd. De samenvatting staat in
de taal van het project.

1. Zorg eerst dat het transcript klopt (deel 1). Een samenvatting kan niet beter zijn dan de
   tekst eronder.
2. Scherp de "Projectcontext" aan. Open "Beheren", "Algemeen", of klik op "Projectcontext
   instellen" in het "Overzicht". Schrijf waar het project over gaat en wat je wilt leren.
3. Open het gesprek en klik naast "Samenvatting" op "Samenvatting opnieuw genereren", en dan
   op "Opnieuw genereren". De nieuwe samenvatting vervangt de huidige, en die ben je kwijt.

Verder goed om te weten:

- Staat "Automatisch titels genereren" aan, dan wordt ook de titel opnieuw geschreven en
  kunnen er trefwoorden bij komen.
- Je kunt de samenvatting zelf schrijven. Klik op "Beheren" in de rij van het gesprek om
  "Gesprek bewerken" te openen en typ over de tekst heen.
- Een samenvatting in de verkeerde taal volgt de "Taal" van het project. Pas die aan in de
  portaalbewerker en genereer de samenvatting opnieuw.
- Staat er `[No transcript available]` als samenvatting, dan heeft het gesprek geen tekst.
  Zie deel 3.

## 3. Er is geen transcript of samenvatting

| Wat je ziet | Wat het betekent | Wat je doet |
|---|---|---|
| "Wordt getranscribeerd" in de lijst, of "Transcriptie wordt uitgevoerd..." bij een stuk | dembrane is ermee bezig. | Wacht. Een stuk dat mislukt wordt ongeveer 15 minuten lang opnieuw geprobeerd voordat dembrane het opgeeft. |
| "Er is nog geen transcript beschikbaar voor dit gesprek. Controleer later opnieuw." | Er is geen stuk audio binnengekomen. | Tijdens een opname: wacht, het eerste stuk komt na 30 seconden binnen. Bij een afgerond gesprek: zie "Leeg". |
| "Leeg" | In de lijst: er is geen audio binnengekomen. Op de pagina van het gesprek: het gesprek is afgerond en heeft geen tekst. | Een opname die net is begonnen vult zich vanzelf. Bij een afgerond gesprek zonder audio valt er niets terug te halen, dus vraag de deelnemer om opnieuw op te nemen. Zie je ook "Transcriptiefout", volg dan de volgende rij. |
| "Transcriptiefout", en "Kan dit fragment niet verwerken" in het transcript | Een deel van de audio kon niet worden getranscribeerd. De rest is getranscribeerd en samengevat, en de opname is bewaard. | Transcribeer opnieuw, dan krijgt de hele opname een nieuwe beurt. Mislukt hetzelfde deel weer, laat het ons dan weten via "Feedback geven". |
| "Samenvatting genereren" is grijs | Voor een samenvatting is eerst transcripttekst nodig. | Wacht op het transcript en klik dan op "Samenvatting genereren". |
| Een afgerond gesprek heeft nog geen samenvatting | De samenvatting is nog niet geschreven, of de poging is mislukt. | dembrane probeert het elke 5 minuten opnieuw. Je kunt ook op "Samenvatting genereren" klikken. |
| "Vergrendeld", met "Je hebt je transcriptielimiet bereikt" | Het ene uur audio van het gratis plan was op voordat dit gesprek werd afgerond. | Er is niets verloren. Het gesprek gaat open zodra de werkruimte een betaald abonnement heeft. Zie [tiers, facturering en gebruik](./tiers-billing-and-usage.md). |

## Kom je er niet uit?

Open het gesprek en klik op "Feedback geven" onder "Help", onderaan de zijbalk. Je huidige
pagina wordt meegestuurd, zodat het team van dembrane het gesprek kan terugvinden. Andere
manieren om ons te bereiken staan in [hulp krijgen](./getting-help.md).

## Gerelateerd

- [Transcripten & gesprekken](./transcripts-and-conversations.md)
- [Het portaal instellen](./portal-editor.md)
- [Gesprekken verzamelen](./collecting-conversations.md)
- [Tiers, facturering en gebruik](./tiers-billing-and-usage.md)
- [Hulp krijgen](./getting-help.md)
