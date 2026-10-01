/**
 * The small part of Jinja the report and summary prompts use, rendered the way Jinja 2
 * renders them with the Python API's settings (no autoescape for .jinja, no block
 * trimming, the file's final newline dropped): text, `{{ expr }}`, `{% if %}` with an
 * optional `{% else %}`, and `{% for x in y %}`. Expressions are names, dotted lookups,
 * `x|length == 0` and `x | replace("a", "b")`. Values print as Python's str() would, so a
 * missing participant name still reads "None" to the model, exactly as before.
 */

type Node =
  | { kind: "text"; text: string }
  | { kind: "out"; expr: string }
  | { kind: "if"; cond: string; yes: Node[]; no: Node[] }
  | { kind: "for"; name: string; iter: string; body: Node[] };

const TAG = /\{%\s*([\s\S]*?)\s*%\}|\{\{\s*([\s\S]*?)\s*\}\}/g;

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Node & { kind: "if" | "for" }; inElse?: boolean }[] = [
    { nodes: root },
  ];
  const top = () => stack[stack.length - 1] as (typeof stack)[number];
  const push = (n: Node) => {
    const t = top();
    if (t.node?.kind === "if") (t.inElse ? t.node.no : t.node.yes).push(n);
    else if (t.node?.kind === "for") t.node.body.push(n);
    else t.nodes.push(n);
  };
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    if (m.index > last) push({ kind: "text", text: source.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      push({ kind: "out", expr: m[2] });
      continue;
    }
    const stmt = (m[1] ?? "").trim();
    const ifm = /^if\s+(.+)$/.exec(stmt);
    const form = /^for\s+(\w+)\s+in\s+(.+)$/.exec(stmt);
    if (ifm) {
      const node: Node & { kind: "if" } = {
        kind: "if",
        cond: ifm[1] as string,
        yes: [],
        no: [],
      };
      push(node);
      stack.push({ nodes: [], node });
    } else if (form) {
      const node: Node & { kind: "for" } = {
        kind: "for",
        name: form[1] as string,
        iter: form[2] as string,
        body: [],
      };
      push(node);
      stack.push({ nodes: [], node });
    } else if (stmt === "else") top().inElse = true;
    else if (stmt === "endif" || stmt === "endfor") stack.pop();
    else throw new Error(`unsupported template statement: ${stmt}`);
  }
  if (last < source.length) push({ kind: "text", text: source.slice(last) });
  return root;
}

type Scope = Record<string, unknown>;

function lookup(path: string, scope: Scope): unknown {
  let v: unknown = scope;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function literal(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(s.trim());
  if (!m) throw new Error(`unsupported literal: ${s}`);
  return (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
}

function evaluate(expr: string, scope: Scope): unknown {
  const cmp = /^(.+?)\s*==\s*(\d+)$/.exec(expr);
  if (cmp) return evaluate(cmp[1] as string, scope) === Number(cmp[2]);
  const [head, ...filters] = expr.split("|").map((s) => s.trim());
  let v = lookup(head as string, scope);
  for (const f of filters) {
    if (f === "length") v = Array.isArray(v) || typeof v === "string" ? v.length : 0;
    else {
      const rm = /^replace\((.+?),\s*(.+)\)$/.exec(f);
      if (!rm) throw new Error(`unsupported filter: ${f}`);
      v = pyStr(v)
        .split(literal(rm[1] as string))
        .join(literal(rm[2] as string));
    }
  }
  return v;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python's repr() for the JSON-shaped values templates print. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
    .join(", ")}}`;
}

/** Python's str(): strings as they are, everything else as repr; Jinja prints undefined as "". */
export function pyStr(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return pyRepr(v);
}

function run(nodes: Node[], scope: Scope): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "out") out += pyStr(evaluate(n.expr, scope));
    else if (n.kind === "if") out += run(truthy(evaluate(n.cond, scope)) ? n.yes : n.no, scope);
    else {
      const items = evaluate(n.iter, scope);
      for (const item of Array.isArray(items) ? items : [])
        out += run(n.body, { ...scope, [n.name]: item });
    }
  }
  return out;
}

const cache = new Map<string, Node[]>();

export function render(source: string, vars: Scope): string {
  let nodes = cache.get(source);
  if (!nodes) {
    // Jinja drops one trailing newline of the file (keep_trailing_newline=False).
    nodes = parse(source.endsWith("\n") ? source.slice(0, -1) : source);
    cache.set(source, nodes);
  }
  return run(nodes, vars);
}
