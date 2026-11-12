import cs from "./samples/cs.txt" with { type: "text" };
import de from "./samples/de.txt" with { type: "text" };
import en from "./samples/en.txt" with { type: "text" };
import es from "./samples/es.txt" with { type: "text" };
import fr from "./samples/fr.txt" with { type: "text" };
import it from "./samples/it.txt" with { type: "text" };
import nl from "./samples/nl.txt" with { type: "text" };
import uk from "./samples/uk.txt" with { type: "text" };

/**
 * The portal editor's sample conversation (ECHO-1061): about two minutes of neighbours
 * talking about the small park by the library, one speaker per line, in each portal
 * language. English and Dutch are written by hand; the other six were written by a model
 * and want a native reader: samples/machine-written.json lists them.
 */
const SAMPLES = { cs, de, en, es, fr, it, nl, uk } as const;

export type SampleLanguage = keyof typeof SAMPLES;
export const SAMPLE_LANGUAGES = Object.keys(SAMPLES) as SampleLanguage[];

/** The sample in a portal language ("nl", "nl-NL"), English for any other. */
export function sampleConversation(language: string | null | undefined): {
  language: SampleLanguage;
  transcript: string;
} {
  const code = (language ?? "").slice(0, 2).toLowerCase();
  const lang = (SAMPLE_LANGUAGES as string[]).includes(code) ? (code as SampleLanguage) : "en";
  return { language: lang, transcript: SAMPLES[lang].trim() };
}
