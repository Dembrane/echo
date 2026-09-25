/** Quotes about listening, and about what people do together, shown beside
 * the loading sketches. Each one was checked against its original text or a
 * sourced archive (September 25th 2026); `source` says where. They stay in
 * the words they were published in, so they are not translated. */

export interface LoadingQuote {
	text: string;
	author: string;
	source: string;
}

export const LOADING_QUOTES: LoadingQuote[] = [
	{
		author: "Brenda Ueland",
		source: 'Quote Investigator: "Tell Me More", Ladies\' Home Journal (1941)',
		text: "When we are listened to, it creates us, makes us unfold and expand.",
	},
	{
		author: "Hannah Arendt",
		source: "On Violence (1970), p. 44",
		text: "Power corresponds to the human ability not just to act but to act in concert.",
	},
	{
		author: "Simone Weil",
		source: "Wikiquote: letter to Joë Bousquet, 13 April 1942",
		text: "Attention is the rarest and purest form of generosity.",
	},
	{
		author: "Meri Ngaroto, Te Aupōuri",
		source:
			'Māori whakataukī "He aha te mea nui o te ao? He tāngata, he tāngata, he tāngata" (1830s); Te Pou translation',
		text: "What is the most important thing in the world? It is people, it is people, it is people.",
	},
	{
		author: "Ursula K. Le Guin",
		source: '"Telling Is Listening", The Wave in the Mind (2004)',
		text: "Listening is not a reaction, it is a connection.",
	},
	{
		author: "Jane Jacobs",
		source:
			"The Death and Life of Great American Cities (1961), ch. 12, p. 238",
		text: "Cities have the capability of providing something for everybody, only because, and only when, they are created by everybody.",
	},
	{
		author: "Nelson Mandela",
		source: "Long Walk to Freedom (1994), Part One, on the regent's councils",
		text: "Everyone who wanted to speak did so. It was democracy in its purest form.",
	},
	{
		author: "Margaret J. Wheatley",
		source: "Wikiquote: Turning to One Another (2002), p. 55",
		text: "There is no power for change greater than a community discovering what it cares about.",
	},
	{
		author: "Rachel Naomi Remen",
		source: 'Kitchen Table Wisdom (1996), "Just Listen"',
		text: "I suspect that the most basic and powerful way to connect to another person is to listen. Just listen.",
	},
	{
		author: "Desmond Tutu",
		source: "No Future Without Forgiveness (1999), on ubuntu",
		text: "My humanity is caught up, is inextricably bound up, in yours.",
	},
	{
		author: "Michael Ende",
		source: 'Momo (1973), ch. 2 "Listening", tr. J. Maxwell Brownjohn',
		text: "What Momo was better at than anyone else was listening.",
	},
	{
		author: "Arundhati Roy",
		source:
			"Wikiquote: War Talk (2003), p. 86; World Social Forum, Porto Alegre, 2003",
		text: "Another world is not only possible, she is on her way. On a quiet day, I can hear her breathing.",
	},
	{
		author: "Amartya Sen",
		source: "Wikiquote: The Idea of Justice (2009), Preface, p. xiii",
		text: "Democracy has to be judged not just by the institutions that formally exist but by the extent to which different voices from diverse sections of the people can actually be heard.",
	},
	{
		author: "Helen Keller",
		source:
			"Quote Investigator: stage talk, 1920s, in Lash, Helen and Teacher (1980), p. 489",
		text: "Alone we can do so little. Together we can do so much.",
	},
	{
		author: "Martin Luther King Jr.",
		source: "Wikiquote: Letter from Birmingham Jail (1963)",
		text: "We are caught in an inescapable network of mutuality, tied in a single garment of destiny.",
	},
	{
		author: "Paulo Freire",
		source: "Pedagogy of the Oppressed (1968; rev. tr. 1996), ch. 2",
		text: "Dialogue cannot exist … in the absence of a profound love for the world and for people.",
	},
	{
		author: "Zeno of Citium",
		source:
			"Wikiquote: Diogenes Laërtius, Lives of Eminent Philosophers vii.23",
		text: "We have two ears and one mouth, so we should listen more than we say.",
	},
	{
		author: "June Jordan",
		source:
			'Wikiquote: "Poem for South African Women" (1978), in Passion (1980)',
		text: "We are the ones we have been waiting for.",
	},
	{
		author: "Laozi",
		source: "Wikiquote: Tao Te Ching, ch. 17",
		text: 'Of a good leader, who talks little, when his work is done, his aims fulfilled, they will all say, "We did this ourselves."',
	},
];
