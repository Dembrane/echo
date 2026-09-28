import { render } from "./jinja";
import { TEMPLATES } from "./templates";

/**
 * render_prompt: the template in the requested language, else its English version, else
 * an error, as the Python API chose them.
 */
export function renderPrompt(
  name: string,
  language: string,
  vars: Record<string, unknown>,
): string {
  const source = TEMPLATES[`${name}.${language}`] ?? TEMPLATES[`${name}.en`];
  if (source === undefined)
    throw new Error(`Prompt template ${name}.${language}.jinja not found and no default available`);
  return render(source, vars);
}
