import type { PreviewResult } from "@/lib/portalPreview/protocol";

/**
 * Hand-written results for the portal preview (ECHO-1060): one short example per built-in
 * Verify topic and per Explore mode, about one made-up conversation (a group of neighbours
 * on the new square), written to the current prompts in platform/packages/verify/src/
 * defaults.ts and packages/prompts/templates (generate_artifact, get_reply_summarize,
 * get_reply_brainstorm): B1 language, the Verify draft opening with "Draft to correct
 * together." and closing with "Is this right? What is missing or too strong?".
 *
 * The preview chrome labels them as examples; the participant screen shows them as it
 * would show a real result. English and Dutch are written by hand; the other languages
 * were written by a model and want a native reader.
 *
 * ECHO-1061 replaces an example with a real model result: exampleResult is the one place
 * a preview result is made, and PreviewResult.source says which it is.
 */

export type ExampleLanguage =
	| "en"
	| "nl"
	| "de"
	| "fr"
	| "es"
	| "it"
	| "uk"
	| "cs";

type Texts = Record<ExampleLanguage, string>;

const FIRST: Texts = {
	cs: "Koncept k společné opravě.",
	de: "Entwurf zum gemeinsamen Korrigieren.",
	en: "Draft to correct together.",
	es: "Borrador para corregir juntos.",
	fr: "Brouillon à corriger ensemble.",
	it: "Bozza da correggere insieme.",
	nl: "Concept om samen te verbeteren.",
	uk: "Чернетка, щоб разом виправити.",
};

const LAST: Texts = {
	cs: "Je to správně? Co chybí nebo je příliš silné?",
	de: "Stimmt das? Was fehlt oder ist zu stark?",
	en: "Is this right? What is missing or too strong?",
	es: "¿Es correcto? ¿Qué falta o es demasiado fuerte?",
	fr: "Est-ce juste ? Qu'est-ce qui manque ou est trop fort ?",
	it: "È giusto? Cosa manca o è troppo forte?",
	nl: "Klopt dit? Wat ontbreekt of is te stellig?",
	uk: "Чи це правильно? Чого бракує або що занадто сильно?",
};

const lines = (...points: string[]) => points.map((p) => `- ${p}`).join("\n");

const VERIFY_BODY: Record<string, Texts> = {
	actions: {
		cs: lines(
			"Do jara dát na náměstí víc laviček ve stínu. Dohodnuto.",
			"Pan Novák zeptá obec na pítko. Dohodnuto.",
			"Jednou měsíčně trh na náměstí. Navrhli někteří.",
		),
		de: lines(
			"Bis zum Frühling mehr Bänke im Schatten auf den Platz stellen. Vereinbart.",
			"Herr Jansen fragt die Gemeinde nach einem Trinkbrunnen. Vereinbart.",
			"Einmal im Monat ein Markt auf dem Platz. Von einigen vorgeschlagen.",
		),
		en: lines(
			"Put more benches in the shade on the square before spring. Agreed.",
			"Mr Jansen asks the council about a drinking fountain. Agreed.",
			"A market on the square once a month. Suggested by some.",
		),
		es: lines(
			"Poner más bancos a la sombra en la plaza antes de la primavera. Acordado.",
			"El señor Jansen pregunta al ayuntamiento por una fuente. Acordado.",
			"Un mercado en la plaza una vez al mes. Propuesto por algunos.",
		),
		fr: lines(
			"Mettre plus de bancs à l'ombre sur la place avant le printemps. Convenu.",
			"M. Jansen demande une fontaine à boire à la mairie. Convenu.",
			"Un marché sur la place une fois par mois. Proposé par certains.",
		),
		it: lines(
			"Mettere più panchine all'ombra in piazza prima della primavera. Concordato.",
			"Il signor Jansen chiede al comune una fontanella. Concordato.",
			"Un mercato in piazza una volta al mese. Proposto da alcuni.",
		),
		nl: lines(
			"Voor de lente meer bankjes in de schaduw op het plein. Afgesproken.",
			"Meneer Jansen vraagt de gemeente naar een watertappunt. Afgesproken.",
			"Eén keer per maand een markt op het plein. Voorgesteld door sommigen.",
		),
		uk: lines(
			"До весни поставити на площі більше лавок у тіні. Домовилися.",
			"Пан Янсен запитає громаду про питний фонтанчик. Домовилися.",
			"Ринок на площі раз на місяць. Запропонували деякі.",
		),
	},
	agreements: {
		cs: lines(
			"Náměstí potřebuje víc stínu a laviček.",
			"Auta by měla jet pomaleji kolem hřiště.",
			"Večer je tam příliš tma.",
			"Také zaznělo: jeden člověk chce místo laviček víc parkovacích míst.",
		),
		de: lines(
			"Der Platz braucht mehr Schatten und Bänke.",
			"Autos sollen am Spielplatz langsamer fahren.",
			"Abends ist es dort zu dunkel.",
			"Auch gehört: Eine Person möchte lieber mehr Parkplätze statt Bänke.",
		),
		en: lines(
			"The square needs more shade and benches.",
			"Cars should drive slower past the playground.",
			"It is too dark there in the evening.",
			"Also heard: one person would rather have more parking than benches.",
		),
		es: lines(
			"La plaza necesita más sombra y bancos.",
			"Los coches deberían ir más despacio junto al parque infantil.",
			"Por la noche está demasiado oscuro.",
			"También se dijo: una persona prefiere más aparcamiento en vez de bancos.",
		),
		fr: lines(
			"La place a besoin de plus d'ombre et de bancs.",
			"Les voitures devraient rouler moins vite près de l'aire de jeux.",
			"Le soir, il y fait trop sombre.",
			"Aussi entendu : une personne préfère plus de parking plutôt que des bancs.",
		),
		it: lines(
			"La piazza ha bisogno di più ombra e panchine.",
			"Le auto dovrebbero andare più piano vicino al parco giochi.",
			"La sera è troppo buio.",
			"Sentito anche: una persona vorrebbe più parcheggi invece delle panchine.",
		),
		nl: lines(
			"Het plein heeft meer schaduw en bankjes nodig.",
			"Auto's moeten langzamer rijden langs de speeltuin.",
			"Het is er 's avonds te donker.",
			"Ook gehoord: één persoon wil liever meer parkeerplaatsen dan bankjes.",
		),
		uk: lines(
			"Площі потрібно більше тіні та лавок.",
			"Машини мають їхати повільніше біля дитячого майданчика.",
			"Увечері там надто темно.",
			"Також почули: одна людина хоче більше паркування замість лавок.",
		),
	},
	disagreements: {
		cs: lines(
			"Parkování: někteří chtějí méně míst kvůli zeleni, jiní je potřebují pro návštěvy.",
			"Večerní akce: někteří chtějí víc života, jiní klid po desáté.",
		),
		de: lines(
			"Parken: Einige wollen weniger Plätze für mehr Grün, andere brauchen sie für Besuch.",
			"Abends: Einige wollen mehr Leben auf dem Platz, andere Ruhe nach zehn Uhr.",
		),
		en: lines(
			"Parking: some want fewer spaces for more green, others need them for visitors.",
			"Evenings: some want more life on the square, others want quiet after ten.",
		),
		es: lines(
			"Aparcamiento: algunos quieren menos plazas para más verde, otros las necesitan para las visitas.",
			"Las noches: algunos quieren más vida en la plaza, otros silencio después de las diez.",
		),
		fr: lines(
			"Stationnement : certains veulent moins de places pour plus de vert, d'autres en ont besoin pour les visites.",
			"Le soir : certains veulent plus de vie sur la place, d'autres du calme après dix heures.",
		),
		it: lines(
			"Parcheggi: alcuni vogliono meno posti per più verde, altri ne hanno bisogno per le visite.",
			"La sera: alcuni vogliono più vita in piazza, altri silenzio dopo le dieci.",
		),
		nl: lines(
			"Parkeren: sommigen willen minder plekken voor meer groen, anderen hebben ze nodig voor bezoek.",
			"Avonden: sommigen willen meer leven op het plein, anderen rust na tien uur.",
		),
		uk: lines(
			"Паркування: дехто хоче менше місць заради зелені, іншим вони потрібні для гостей.",
			"Вечори: дехто хоче більше життя на площі, інші хочуть тиші після десятої.",
		),
	},
	gems: {
		cs: lines(
			"„Starý strom u kostela je jediné místo, kde se děti a senioři opravdu potkají.“",
			"Jedna osoba navrhla lavičky, které si mohou opravit sami sousedé.",
		),
		de: lines(
			"„Der alte Baum bei der Kirche ist der einzige Ort, an dem sich Kinder und Ältere wirklich treffen.“",
			"Eine Person schlug Bänke vor, die die Nachbarn selbst reparieren können.",
		),
		en: lines(
			"'The old tree by the church is the only place where kids and older people really meet.'",
			"One person suggested benches that neighbours can repair themselves.",
		),
		es: lines(
			"«El árbol viejo junto a la iglesia es el único sitio donde niños y mayores se encuentran de verdad.»",
			"Una persona propuso bancos que los vecinos puedan arreglar ellos mismos.",
		),
		fr: lines(
			"« Le vieil arbre près de l'église est le seul endroit où enfants et personnes âgées se rencontrent vraiment. »",
			"Une personne a proposé des bancs que les voisins peuvent réparer eux-mêmes.",
		),
		it: lines(
			"«Il vecchio albero vicino alla chiesa è l'unico posto dove bambini e anziani si incontrano davvero.»",
			"Una persona ha proposto panchine che i vicini possono riparare da soli.",
		),
		nl: lines(
			"'De oude boom bij de kerk is de enige plek waar kinderen en ouderen elkaar echt treffen.'",
			"Eén persoon stelde bankjes voor die buren zelf kunnen repareren.",
		),
		uk: lines(
			"«Старе дерево біля церкви: це єдине місце, де діти й літні люди справді зустрічаються.»",
			"Одна людина запропонувала лавки, які сусіди можуть ремонтувати самі.",
		),
	},
	heard: {
		cs: lines(
			"Na náměstí chodíme hlavně v sobotu.",
			"Chybí stín, v létě se tam nedá sedět.",
			"Děti si hrají blízko silnice.",
			"Chceme o plánech slyšet dřív.",
		),
		de: lines(
			"Wir gehen vor allem samstags auf den Platz.",
			"Es fehlt Schatten, im Sommer kann man dort nicht sitzen.",
			"Die Kinder spielen nah an der Straße.",
			"Wir wollen früher von den Plänen hören.",
		),
		en: lines(
			"We mostly go to the square on Saturdays.",
			"There is no shade, you cannot sit there in summer.",
			"The children play close to the road.",
			"We want to hear about the plans earlier.",
		),
		es: lines(
			"Vamos a la plaza sobre todo los sábados.",
			"No hay sombra, en verano no se puede sentar uno allí.",
			"Los niños juegan cerca de la calle.",
			"Queremos saber de los planes antes.",
		),
		fr: lines(
			"Nous allons surtout sur la place le samedi.",
			"Il n'y a pas d'ombre, on ne peut pas s'y asseoir en été.",
			"Les enfants jouent près de la route.",
			"Nous voulons entendre parler des projets plus tôt.",
		),
		it: lines(
			"Andiamo in piazza soprattutto il sabato.",
			"Non c'è ombra, d'estate non ci si può sedere.",
			"I bambini giocano vicino alla strada.",
			"Vogliamo sapere dei progetti prima.",
		),
		nl: lines(
			"We gaan vooral op zaterdag naar het plein.",
			"Er is geen schaduw, in de zomer kun je er niet zitten.",
			"De kinderen spelen dicht bij de weg.",
			"We willen eerder horen over de plannen.",
		),
		uk: lines(
			"Ми ходимо на площу переважно в суботу.",
			"Там немає тіні, влітку не можна посидіти.",
			"Діти граються близько до дороги.",
			"Ми хочемо дізнаватися про плани раніше.",
		),
	},
	moments: {
		cs: lines(
			"Když někdo řekl, že jeho matka kvůli chybějícím lavičkám nechodí ven, skupina začala mluvit spíš o lavičkách než o parkování.",
		),
		de: lines(
			"Als jemand erzählte, dass seine Mutter wegen fehlender Bänke nicht mehr rausgeht, sprach die Gruppe mehr über Bänke als über Parken.",
		),
		en: lines(
			"When someone said their mother no longer goes out because there are no benches, the group talked more about benches than about parking.",
		),
		es: lines(
			"Cuando alguien contó que su madre ya no sale porque no hay bancos, el grupo habló más de bancos que de aparcamiento.",
		),
		fr: lines(
			"Quand quelqu'un a dit que sa mère ne sort plus faute de bancs, le groupe a parlé davantage des bancs que du stationnement.",
		),
		it: lines(
			"Quando qualcuno ha detto che sua madre non esce più perché mancano le panchine, il gruppo ha parlato più di panchine che di parcheggi.",
		),
		nl: lines(
			"Toen iemand vertelde dat zijn moeder niet meer naar buiten gaat omdat er geen bankjes zijn, ging het gesprek meer over bankjes dan over parkeren.",
		),
		uk: lines(
			"Коли хтось розповів, що його мама більше не виходить, бо немає лавок, група почала більше говорити про лавки, ніж про паркування.",
		),
	},
	truths: {
		cs: lines(
			"„Vlastně nevíme, jestli obec náš názor poslouchá.“",
			"Mladí lidé dnes chyběli.",
		),
		de: lines(
			"„Wir wissen eigentlich nicht, ob die Gemeinde auf uns hört.“",
			"Junge Leute waren heute nicht dabei.",
		),
		en: lines(
			"'We don't really know if the council listens to us.'",
			"Young people were not here today.",
		),
		es: lines(
			"«En realidad no sabemos si el ayuntamiento nos escucha.»",
			"Hoy no vinieron jóvenes.",
		),
		fr: lines(
			"« On ne sait pas vraiment si la mairie nous écoute. »",
			"Les jeunes n'étaient pas là aujourd'hui.",
		),
		it: lines(
			"«Non sappiamo davvero se il comune ci ascolta.»",
			"Oggi i giovani non c'erano.",
		),
		nl: lines(
			"'We weten eigenlijk niet of de gemeente naar ons luistert.'",
			"Jongeren waren er vandaag niet bij.",
		),
		uk: lines(
			"«Ми насправді не знаємо, чи громада нас слухає.»",
			"Сьогодні не було молоді.",
		),
	},
};

const EXPLORE: Record<string, Texts> = {
	// get_reply_brainstorm: two short prompts, at most 40 words, not ranked.
	brainstorm: {
		cs: "Co kdyby lavičky navrhly samy děti?\nCo kdyby se náměstí jednu sobotu v měsíci uzavřelo pro auta?",
		de: "Was wäre, wenn Kinder die Bänke selbst entwerfen?\nWas wäre, wenn der Platz einen Samstag im Monat autofrei ist?",
		en: "What if children designed the benches themselves?\nWhat if the square were free of cars one Saturday a month?",
		es: "¿Y si los niños diseñaran ellos mismos los bancos?\n¿Y si la plaza estuviera sin coches un sábado al mes?",
		fr: "Et si les enfants dessinaient eux-mêmes les bancs ?\nEt si la place était sans voitures un samedi par mois ?",
		it: "E se fossero i bambini a progettare le panchine?\nE se la piazza fosse senza auto un sabato al mese?",
		nl: "Wat als kinderen de bankjes zelf ontwerpen?\nWat als het plein één zaterdag per maand autovrij is?",
		uk: "А якщо діти самі придумають лавки?\nА якщо одну суботу на місяць площа буде без машин?",
	},
	// get_reply_summarize: one open question, at most 25 words.
	summarize: {
		cs: "Mluvili jste o stínu a lavičkách. Jak by náměstí mělo vypadat v létě v šest večer?",
		de: "Ihr habt über Schatten und Bänke gesprochen. Wie sollte der Platz an einem Sommerabend um sechs aussehen?",
		en: "You talked about shade and benches. What should the square look like at six on a summer evening?",
		es: "Hablasteis de sombra y bancos. ¿Cómo debería ser la plaza un atardecer de verano a las seis?",
		fr: "Vous avez parlé d'ombre et de bancs. À quoi devrait ressembler la place un soir d'été à six heures ?",
		it: "Avete parlato di ombra e panchine. Come dovrebbe essere la piazza alle sei di una sera d'estate?",
		nl: "Jullie hadden het over schaduw en bankjes. Hoe ziet het plein eruit op een zomeravond om zes uur?",
		uk: "Ви говорили про тінь і лавки. Якою має бути площа влітку о шостій вечора?",
	},
};

const lang = (language: string): ExampleLanguage =>
	(["en", "nl", "de", "fr", "es", "it", "uk", "cs"] as const).find(
		(l) => l === language,
	) ?? "en";

/** The topics and modes with a hand-written example. */
export const EXAMPLE_TOPIC_KEYS = Object.keys(VERIFY_BODY);
export const EXAMPLE_EXPLORE_MODES = Object.keys(EXPLORE);

/**
 * The example a preview shows for a Verify topic or an Explore mode, in the portal's
 * language. A custom topic gets the "What we heard" example and the custom Explore mode
 * the one-question example: a host's own prompt shapes the real result.
 */
export function exampleResult(
	kind: "verify" | "explore",
	key: string,
	language: string,
): PreviewResult {
	const l = lang(language);
	if (kind === "explore") {
		const texts = EXPLORE[key] ?? EXPLORE.summarize;
		return { key, source: "example", text: texts[l] };
	}
	const body = (VERIFY_BODY[key] ?? VERIFY_BODY.heard)[l];
	return {
		key,
		source: "example",
		text: `${FIRST[l]}\n\n${body}\n\n${LAST[l]}`,
	};
}
