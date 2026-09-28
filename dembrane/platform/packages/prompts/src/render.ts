import nunjucks from "nunjucks";
import { TEMPLATES } from "./templates.generated";

/**
 * The Python API's prompt templates, rendered the way Jinja2 rendered them, so every
 * model sees the same text it saw before. Three Jinja behaviours differ from nunjucks
 * and are reproduced here: output of Python values (True, False, None, list repr), no
 * autoescaping for .jinja files, and dropping one trailing newline from each template.
 */

class MemoryLoader extends nunjucks.Loader implements nunjucks.ILoader {
  getSource(name: string): nunjucks.LoaderSource {
    const src = TEMPLATES[name];
    if (src === undefined) throw new Error(`prompt template ${name} not found`);
    // Jinja's keep_trailing_newline=False removes exactly one final newline.
    return { src: src.endsWith("\n") ? src.slice(0, -1) : src, path: name, noCache: false };
  }
}

/** Python's str() of a value, which is what Jinja prints for {{ value }}. */
export function pythonStr(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) && Object.is(v, -0) ? "-0" : String(v);
  return pythonRepr(v);
}

function pythonRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
    return q + (q === "'" ? body.replaceAll("'", "\\'") : body) + q;
  }
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(pythonRepr).join(", ")}]`;
  if (typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pythonRepr(k)}: ${pythonRepr(x)}`)
      .join(", ")}}`;
  return String(v);
}

const env = new nunjucks.Environment(new MemoryLoader(), {
  autoescape: false,
  throwOnUndefined: false,
});

// nunjucks prints values through runtime.suppressValue; Jinja prints Python's str(value).
type Runtime = { suppressValue: (val: unknown, autoescape: boolean) => unknown };
const runtime = (nunjucks as unknown as { runtime: Runtime }).runtime;
const original = runtime.suppressValue;
runtime.suppressValue = (val, autoescape) => {
  if (val === null || typeof val === "boolean" || Array.isArray(val)) return pythonStr(val);
  if (val && typeof val === "object" && !(val instanceof String) && !("val" in val))
    return pythonStr(val);
  return original(val, autoescape);
};

export function hasTemplate(name: string, language: string): boolean {
  return `${name}.${language}.jinja` in TEMPLATES;
}

/**
 * render_prompt(name, language, kwargs): the language's template, falling back to the
 * English one, and an error when neither exists.
 */
export function renderPrompt(
  name: string,
  language: string,
  vars: Record<string, unknown> = {},
): string {
  let file = `${name}.${language}.jinja`;
  if (!(file in TEMPLATES)) {
    const fallback = `${name}.en.jinja`;
    if (!(fallback in TEMPLATES))
      throw new Error(`Prompt template ${file} not found and no default available`);
    file = fallback;
  }
  return env.render(file, vars);
}
