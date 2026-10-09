#!/usr/bin/env bun
/**
 * Download every audio chunk of a conversation and join them into one file.
 *
 *   bun scripts/download-conversation-audio.ts [project_id | dashboard_url] [options]
 *
 * With nothing given it lists your workspaces, then the workspace's projects, then the
 * project's conversations, asking at each step. --workspace or --project skips ahead, and
 * a dashboard URL (…/w/<workspace>/projects/<project>/…) skips ahead and picks the target.
 * Each conversation you pick becomes one file, its chunks in timestamp order.
 * A chunk that is empty or won't decode is left out and named in the output. Rerunning
 * into the same --out-dir skips conversations whose file is already there.
 *
 * Targets:
 *   --target prod   dashboard.dembrane.com           (the Python API on main)
 *   --target next   dashboard.echo-next.dembrane.com (the Python API on main), default
 *   --target local  the bun API on http://localhost:8080
 * Both APIs serve the same routes this needs: /v2/workspaces, /v2/workspaces/:id/projects,
 * /v2/bff/conversations, /v2/bff/conversations/:id/chunks and
 * /conversations/:cid/chunks/:chunk_id/content. They differ only in how you sign in.
 *
 * Auth: pass a token with --token (or DEMBRANE_TOKEN), or leave it out to sign in here.
 *   prod, next: the `directus_session_token` cookie from devtools on the dashboard
 *               (Application → Cookies).
 *   local:      the `dembrane.session_token` cookie from the local dashboard.
 *
 * Needs ffmpeg on PATH.
 */
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

type Auth = "directus" | "better-auth";
type Target = { auth: Auth; api: string; directus?: string; origin: string };

const TARGETS: Record<string, Target> = {
  prod: {
    auth: "directus",
    api: "https://api.dembrane.com/api",
    directus: "https://directus.dembrane.com",
    origin: "https://dashboard.dembrane.com",
  },
  next: {
    auth: "directus",
    api: "https://api.echo-next.dembrane.com/api",
    directus: "https://directus.echo-next.dembrane.com",
    origin: "https://dashboard.echo-next.dembrane.com",
  },
  local: {
    auth: "better-auth",
    api: "http://localhost:8080/api",
    origin: "http://localhost:5173",
  },
};

const USAGE = `Usage: bun scripts/download-conversation-audio.ts [project_id | dashboard_url] [options]

Options:
  --target <prod|next|local> Which environment (default: next, or from a dashboard URL)
  --workspace <id>           Start from this workspace's projects
  --project <id>             Start from this project's conversations
  --conversation <id>        Skip the conversation picker; repeatable
  --all                      Skip the conversation picker and take every conversation
  --token <token>            Session token (or set DEMBRANE_TOKEN); omit to sign in
  --api-url <url>            Override the API base URL (ends in /api)
  --directus-url <url>       Override the Directus URL used to sign in
  --out-dir <dir>            Parent of the per-project folders (default: ./conversation-audio)
  --format <ext>             Output format: mp3, wav, m4a, ogg... (default: mp3)
  --keep-chunks              Keep the downloaded chunks next to the output
  --help                     Show this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    workspace: { type: "string" },
    project: { type: "string" },
    conversation: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    token: { type: "string" },
    "api-url": { type: "string" },
    "directus-url": { type: "string" },
    "out-dir": { type: "string", default: "conversation-audio" },
    format: { type: "string", default: "mp3" },
    "keep-chunks": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

// What it prints is the output, so it goes straight to stdout and stderr.
const print = (s = "") => process.stdout.write(`${s}\n`);
const printErr = (s: string) => process.stderr.write(`${s}\n`);

if (opts.help || positionals.length > 1) {
  print(USAGE);
  process.exit(opts.help ? 0 : 1);
}

type Workspace = { id: string; name: string; org_name?: string; role?: string };
type Project = {
  id: string;
  name: string | null;
  conversations_count?: number;
  audio_hours?: number;
};
type Conversation = {
  id: string;
  participant_name: string | null;
  created_at: string | null;
  duration: number | null;
};
type Chunk = { id: string; path: string | null; timestamp: string | null };

function die(message: string): never {
  printErr(message);
  process.exit(1);
}

function stripSlash(url: string) {
  return url.replace(/\/+$/, "");
}

// ── where to start ───────────────────────────────────────────────────

let targetName = opts.target;
let workspaceId = opts.workspace;
let projectId = opts.project;
const conversationIds = [...(opts.conversation ?? [])];

const arg = positionals[0];
if (arg?.startsWith("http")) {
  // A dashboard link: the host picks the target, the path the workspace/project/conversation.
  const url = new URL(arg);
  const byHost = Object.entries(TARGETS).find(([, t]) => new URL(t.origin).host === url.host);
  if (!byHost && !targetName) die(`Don't know which target ${url.host} is; pass --target`);
  targetName ??= byHost?.[0];
  workspaceId ??= url.pathname.match(/\/w\/([^/]+)/)?.[1];
  projectId ??= url.pathname.match(/\/projects\/([^/]+)/)?.[1];
  const convo = url.pathname.match(/\/conversations\/([^/]+)/)?.[1];
  if (convo && !conversationIds.length) conversationIds.push(convo);
} else if (arg) {
  projectId ??= arg;
}

targetName ??= "next";
const target =
  TARGETS[targetName] ??
  die(`Unknown --target ${targetName}; use ${Object.keys(TARGETS).join(", ")}`);
const apiUrl = stripSlash(opts["api-url"] ?? target.api);
const directusUrl = stripSlash(opts["directus-url"] ?? target.directus ?? "");

// ── terminal input ───────────────────────────────────────────────────

// Piped input is read through one interface: a second one would miss the lines the first
// had already buffered. A terminal gets one per question, so askHidden can take raw mode.
let piped: AsyncIterator<string> | undefined;

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${question} `);
    piped ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const next = await piped.next();
    if (next.done) die("\nInput ended");
    print();
    return next.value.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Readline takes Ctrl+C as a key, not a signal, and would only reject the question.
  rl.on("SIGINT", () => {
    rl.close();
    print();
    process.exit(130);
  });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it; falls back to ask() when stdin isn't a terminal. */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(`${question} `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ── auth ─────────────────────────────────────────────────────────────

/** A cookie value copied from devtools may still be URL-encoded (better-auth signs it). */
function normalizeToken(raw: string) {
  const t = raw.trim().replace(/^Bearer\s+/i, "");
  return t.includes("%") ? decodeURIComponent(t) : t;
}

type DirectusLogin = {
  data?: { access_token?: string };
  errors?: { extensions?: { code?: string } }[];
};

async function signIn(): Promise<string> {
  const email = await ask("Email:");
  if (!email) die("No email given");
  const password = await askHidden("Password:");

  if (target.auth === "directus") {
    if (!directusUrl) die("Signing in here needs --directus-url");
    const login = (body: Record<string, string>) =>
      fetch(`${directusUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let res = await login({ email, password });
    let json = (await res.json().catch(() => ({}))) as DirectusLogin;
    if (!res.ok && json?.errors?.[0]?.extensions?.code === "INVALID_OTP") {
      res = await login({ email, password, otp: await ask("2FA code:") });
      json = (await res.json().catch(() => ({}))) as DirectusLogin;
    }
    if (!res.ok) die(`Sign-in failed (${res.status}): ${JSON.stringify(json)}`);
    return json.data?.access_token ?? die("Signed in, but the response carried no access token");
  }

  const res = await fetch(`${apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: target.origin },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as { twoFactorRedirect?: boolean };
  if (!res.ok) die(`Sign-in failed (${res.status}): ${JSON.stringify(json)}`);
  if (json?.twoFactorRedirect) {
    // The second step is tied to the two-factor cookie the first one set.
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const verify = await fetch(`${apiUrl}/auth/two-factor/verify-totp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: target.origin, cookie },
      body: JSON.stringify({ code: await ask("2FA code:") }),
    });
    const token = verify.headers.get("set-auth-token");
    if (!verify.ok || !token)
      die(`2FA failed (${verify.status}): ${await verify.text().catch(() => "")}`);
    return token;
  }
  const token = res.headers.get("set-auth-token");
  if (!token) die("Signed in, but the response carried no set-auth-token header");
  return token;
}

const rawToken = opts.token ?? process.env.DEMBRANE_TOKEN;
const token = rawToken ? normalizeToken(rawToken) : await signIn();
const authHeaders = { authorization: `Bearer ${token}` };

async function getJson<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
  );
  const url = `${apiUrl}${path}${query.size ? `?${query}` : ""}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) {
    const hint = res.status === 401 ? " (token expired or wrong for this target?)" : "";
    die(`GET ${url} → ${res.status}${hint}\n${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

/** Pages through a list endpoint that takes limit/offset and answers with an array. */
async function getAll<T>(path: string, params: Record<string, string | number>, pageSize = 1000) {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await getJson<T[]>(path, { ...params, limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

// ── listing ──────────────────────────────────────────────────────────

async function listWorkspaces(): Promise<Workspace[]> {
  return (await getJson<{ workspaces: Workspace[] }>("/v2/workspaces")).workspaces;
}

async function listProjects(wsId: string): Promise<Project[]> {
  const byId = new Map<string, Project>();
  for (let offset = 0; ; offset += 100) {
    const page = await getJson<{ pinned?: Project[]; projects: Project[]; has_more: boolean }>(
      `/v2/workspaces/${wsId}/projects`,
      { limit: 100, offset },
    );
    for (const p of [...(page.pinned ?? []), ...page.projects]) byId.set(p.id, p);
    if (!page.has_more || !page.projects.length) return [...byId.values()];
  }
}

function listConversations(pid: string) {
  return getAll<Conversation>("/v2/bff/conversations", {
    project_id: pid,
    fields: "id,participant_name,created_at,duration",
    sort: "-created_at",
  });
}

function listChunks(conversationId: string) {
  return getAll<Chunk>(`/v2/bff/conversations/${conversationId}/chunks`, {
    fields: "id,path,timestamp",
    sort: "timestamp",
  });
}

// ── picking ──────────────────────────────────────────────────────────

/** "1,3-5" → [0, 2, 3, 4] (input is 1-based); "all" → every index. */
function parseSelection(input: string, count: number): number[] {
  if (input.toLowerCase() === "all") return [...Array(count).keys()];
  const picked = new Set<number>();
  for (const part of input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Not a number or range: ${part}`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) {
      if (i < 1 || i > count) throw new Error(`Out of range: ${i}`);
      picked.add(i - 1);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

async function choose<T>(title: string, items: T[], label: (t: T) => string, many: boolean) {
  print(`\n${title}`);
  for (const [i, t] of items.entries()) print(`${String(i + 1).padStart(4)}. ${label(t)}`);
  const hint = many ? "e.g. 3, 1,4-6, all" : "a number";
  for (;;) {
    try {
      const picked = parseSelection(await ask(`\nWhich? (${hint})`), items.length);
      if (picked.length === 1 || (many && picked.length)) return picked.map((i) => items[i] as T);
      printErr(many ? "Pick at least one" : "Pick exactly one");
    } catch (err) {
      printErr((err as Error).message);
    }
  }
}

async function chooseOne<T>(title: string, items: T[], label: (t: T) => string) {
  return (await choose(title, items, label, false))[0] as T;
}

const col = (s: string, w: number) => s.padEnd(w).slice(0, w);

async function chooseProject(): Promise<string> {
  if (!workspaceId) {
    const workspaces = await listWorkspaces();
    if (!workspaces.length) die("You have no workspaces on this target");
    const ws =
      workspaces.length === 1
        ? (workspaces[0] as Workspace)
        : await chooseOne(
            "Workspaces:",
            workspaces,
            (w) => `${col(w.name, 40)}  ${col(w.org_name ?? "", 28)}  ${w.id}`,
          );
    if (workspaces.length === 1) print(`Workspace: ${ws.name}`);
    workspaceId = ws.id;
  }
  const projects = await listProjects(workspaceId);
  if (!projects.length) die(`No projects in workspace ${workspaceId} (or no access to them)`);
  const project = await chooseOne(
    "Projects:",
    projects,
    (p) =>
      `${col(p.name?.trim() || "(unnamed)", 40)}  ${String(p.conversations_count ?? "?").padStart(4)} convs  ${String(p.audio_hours ?? "?").padStart(6)} h  ${p.id}`,
  );
  return project.id;
}

async function chooseConversations(conversations: Conversation[]): Promise<Conversation[]> {
  if (opts.all) return conversations;
  if (conversationIds.length) {
    const byId = new Map(conversations.map((c) => [c.id, c]));
    return conversationIds.map(
      (id) => byId.get(id) ?? die(`Conversation ${id} is not in project ${projectId}`),
    );
  }
  return choose(
    "Conversations:",
    conversations,
    (c) => {
      const date = c.created_at ? c.created_at.slice(0, 16).replace("T", " ") : "?";
      const mins = c.duration ? `${(c.duration / 60).toFixed(1)} min` : "";
      return `${col(c.participant_name?.trim() || "(unnamed)", 36)}  ${date}  ${mins.padStart(9)}  ${c.id}`;
    },
    true,
  );
}

// ── download + join ──────────────────────────────────────────────────

function chunkAudioUrl(conversationId: string, chunkId: string) {
  return getJson<string>(`/conversations/${conversationId}/chunks/${chunkId}/content`, {
    return_url: "true",
  });
}

function extOf(url: string) {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return m ? (m[1] as string).toLowerCase() : "bin";
}

function safeName(s: string) {
  return (
    s
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "conversation"
  );
}

/** 222 → "3m42s", 3822 → "1h03m42s". */
function formatDuration(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}h${pad(m)}m${pad(s % 60)}s` : `${m}m${pad(s % 60)}s`;
}

async function probeSeconds(file: string) {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`ffprobe failed on ${file}`);
  return Number(out.trim());
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed:\n${stderr.slice(-2000)}`);
}

/** A file an earlier run finished for this conversation: `<base>-<duration>.<format>`. */
async function existingOutput(outDir: string, base: string) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const done = new RegExp(`^${escaped}-(\\d+h)?\\d+m\\d{2}s\\.${opts.format}$`);
  return (await readdir(outDir)).find((f) => done.test(f));
}

async function download(c: Conversation, outDir: string) {
  const base = `${safeName(c.participant_name ?? "")}-${c.id.slice(0, 8)}`;
  const existing = await existingOutput(outDir, base);
  if (existing) {
    print(`  ${base}: already there → ${join(outDir, existing)}`);
    return;
  }
  const chunks = (await listChunks(c.id)).filter((ch) => ch.path);
  if (!chunks.length) {
    printErr(`  ${c.id}: no chunks with audio (a locked conversation hides them), skipped`);
    return;
  }
  const work = opts["keep-chunks"]
    ? join(outDir, `${base}-chunks`)
    : await mkdtemp(join(tmpdir(), "echo-audio-"));
  await mkdir(work, { recursive: true });

  try {
    // Chunks come in whatever format the recorder or upload produced (webm, mp3, wav…),
    // so each is decoded to the same PCM wav before they are joined.
    // A chunk that is empty or won't decode is left out, as the server's own merge does:
    // a recording stopped mid-upload can leave a 0-byte last chunk.
    const wavs: string[] = [];
    const skipped: string[] = [];
    for (const [i, ch] of chunks.entries()) {
      const n = String(i + 1).padStart(4, "0");
      process.stdout.write(`\r  ${base}: chunk ${i + 1}/${chunks.length}`);
      const url = await chunkAudioUrl(c.id, ch.id);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`chunk ${ch.id}: GET audio → ${res.status}`);
      const raw = join(work, `${n}-${ch.id}.${extOf(url)}`);
      await Bun.write(raw, res);
      if (Bun.file(raw).size === 0) {
        skipped.push(`${i + 1} (empty)`);
        continue;
      }
      const wav = join(work, `${n}.wav`);
      const decoded = await run([
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        raw,
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        wav,
      ]).then(
        () => true,
        () => false,
      );
      if (!decoded) {
        skipped.push(`${i + 1} (won't decode)`);
        continue;
      }
      wavs.push(wav);
    }
    if (!wavs.length)
      throw new Error(`none of the ${chunks.length} chunks has audio: ${skipped.join(", ")}`);
    const list = join(work, "list.txt");
    await Bun.write(list, wavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
    // Written under a temporary name first: the duration in the final name is read
    // from the joined file itself.
    const partial = join(outDir, `${base}.partial.${opts.format}`);
    await run(["ffmpeg", "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, partial]);
    const out = join(
      outDir,
      `${base}-${formatDuration(await probeSeconds(partial))}.${opts.format}`,
    );
    await rename(partial, out);
    if (!opts["keep-chunks"]) await rm(work, { recursive: true, force: true });
    else for (const w of [...wavs, list]) await rm(w, { force: true });
    const note = skipped.length ? ` (skipped chunk ${skipped.join(", ")})` : "";
    print(`\r  ${base}: ${wavs.length}/${chunks.length} chunks → ${out}${note}`);
  } catch (err) {
    printErr(`\n  ${base}: failed, partial files in ${work}\n  ${(err as Error).message}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────

if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) die("ffmpeg and ffprobe need to be on PATH");

projectId ??= await chooseProject();
const conversations = await listConversations(projectId);
if (!conversations.length) die(`No conversations in project ${projectId} (or no access to it)`);
const chosen = await chooseConversations(conversations);
// One folder per project, so same-named conversations from different projects don't mix.
const project = await getJson<{ name: string | null }>(`/v2/projects/${projectId}`);
const outDir = join(
  opts["out-dir"] as string,
  `${safeName(project.name ?? "")}-${projectId.slice(0, 8)}`,
);
await mkdir(outDir, { recursive: true });
print(`\nDownloading ${chosen.length} conversation(s) into ${outDir}`);
for (const c of chosen) await download(c, outDir);
