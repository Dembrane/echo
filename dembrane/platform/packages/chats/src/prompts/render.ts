import { TEMPLATES } from "./templates.generated";

/**
 * Renders the Python API's Jinja2 prompt templates with the same output, so each model
 * sees the text it saw before. Only the subset these templates use is supported:
 * `{{ path }}`, `{{ path[:n] }}`, `|length`, `{% if %}/{% else %}/{% endif %}` on a truthy
 * value or `== "literal"`, and `{% for x in path %}`. Jinja defaults apply: no block
 * trimming, one trailing newline dropped, values printed as Python's str().
 */

type Ctx = Record<string, unknown>;
type Node =
  | { t: "text"; v: string }
  | { t: "out"; expr: string }
  | { t: "if"; cond: string; yes: Node[]; no: Node[] }
  | { t: "for"; name: string; expr: string; body: Node[] };

const TOKEN = /\{\{(.*?)\}\}|\{%(.*?)%\}/gs;

function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Node & { t: "if" | "for" }; inElse?: boolean }[] = [
    { nodes: root },
  ];
  const top = () => stack[stack.length - 1] as (typeof stack)[number];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) top().nodes.push({ t: "text", v: src.slice(last, idx) });
    last = idx + m[0].length;
    if (m[1] !== undefined) {
      top().nodes.push({ t: "out", expr: m[1].trim() });
      continue;
    }
    const tag = (m[2] ?? "").trim();
    if (tag.startsWith("if ")) {
      const node: Node & { t: "if" } = { t: "if", cond: tag.slice(3).trim(), yes: [], no: [] };
      top().nodes.push(node);
      stack.push({ nodes: node.yes, node });
    } else if (tag === "else") {
      const frame = top();
      if (frame.node?.t !== "if") throw new Error("else without if");
      frame.nodes = frame.node.no;
    } else if (tag === "endif" || tag === "endfor") {
      stack.pop();
    } else if (tag.startsWith("for ")) {
      const fm = /^for\s+(\w+)\s+in\s+(.+)$/.exec(tag);
      if (!fm) throw new Error(`unsupported tag: ${tag}`);
      const node: Node & { t: "for" } = {
        t: "for",
        name: fm[1] as string,
        expr: (fm[2] as string).trim(),
        body: [],
      };
      top().nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else throw new Error(`unsupported tag: ${tag}`);
  }
  if (last < src.length) top().nodes.push({ t: "text", v: src.slice(last) });
  return root;
}

function lookup(expr: string, ctx: Ctx): unknown {
  let e = expr.trim();
  let length = false;
  if (e.endsWith("|length")) {
    length = true;
    e = e.slice(0, -"|length".length).trim();
  }
  let slice: number | null = null;
  const sm = /^(.*)\[:(\d+)\]$/.exec(e);
  if (sm) {
    e = (sm[1] as string).trim();
    slice = Number(sm[2]);
  }
  let v: unknown = ctx;
  for (const part of e.split(".")) {
    v = v && typeof v === "object" ? (v as Ctx)[part] : undefined;
  }
  if (slice !== null && (typeof v === "string" || Array.isArray(v))) v = v.slice(0, slice);
  if (length) return typeof v === "string" || Array.isArray(v) ? v.length : 0;
  return v;
}

/** Python truthiness. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function test(cond: string, ctx: Ctx): boolean {
  const m = /^(.+?)\s*==\s*(.+)$/.exec(cond);
  if (!m) return truthy(lookup(cond, ctx));
  const left = lookup(m[1] as string, ctx);
  const raw = (m[2] as string).trim();
  const right = /^["'].*["']$/.test(raw) ? raw.slice(1, -1) : Number(raw);
  return left === right;
}

/** Python's str() of a value, which is what Jinja prints. */
export function pythonStr(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return pythonRepr(v);
}

/** A float column as Python prints it: 60.0, not 60. Pass the result to a template. */
export function pyFloat(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return Number.isInteger(n) ? `${n}.0` : String(n);
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
    return `{${Object.entries(v as Ctx)
      .map(([k, x]) => `${pythonRepr(k)}: ${pythonRepr(x)}`)
      .join(", ")}}`;
  return String(v);
}

function run(nodes: Node[], ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "out") out += pythonStr(lookup(n.expr, ctx));
    else if (n.t === "if") out += run(test(n.cond, ctx) ? n.yes : n.no, ctx);
    else {
      const items = lookup(n.expr, ctx);
      if (Array.isArray(items))
        for (const it of items) out += run(n.body, { ...ctx, [n.name]: it });
    }
  }
  return out;
}

const cache = new Map<string, Node[]>();

/** render_prompt(name, language, vars): the language's template, else the English one. */
export function renderPrompt(name: string, language: string, vars: Ctx): string {
  let file = `${name}.${language}.jinja`;
  if (TEMPLATES[file] === undefined) file = `${name}.en.jinja`;
  const src = TEMPLATES[file];
  if (src === undefined)
    throw new Error(`Prompt template ${name}.${language}.jinja not found and no default available`);
  let nodes = cache.get(file);
  if (!nodes) {
    nodes = parse(src.endsWith("\n") ? src.slice(0, -1) : src);
    cache.set(file, nodes);
  }
  return run(nodes, vars);
}
