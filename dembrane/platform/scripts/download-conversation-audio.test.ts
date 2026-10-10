import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The script runs end to end, as a user would run it: against a fake API that serves
// real audio, joined by real ffmpeg.

const script = new URL("./download-conversation-audio.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "echo-download-audio-"));

type Chunk = { id: string; path: string | null; timestamp: string; file?: string };

const WORKSPACE = { id: "ws-1", name: "Team", org_name: "Org" };
const PROJECTS = [
  { id: "p1111111-aaaa", name: "Town hall", conversations_count: 2, audio_hours: 0 },
  { id: "p2222222-bbbb", name: "Other", conversations_count: 0, audio_hours: 0 },
  // Reached by id only, so the pickers above stay as they are.
  { id: "p3333333-cccc", name: "Damaged", conversations_count: 2, audio_hours: 0 },
];
const CONVERSATIONS = [
  {
    id: "c1111111-aaaa",
    participant_name: "Ana María",
    created_at: "2026-09-01T10:00:00Z",
    duration: 3,
  },
  { id: "c2222222-bbbb", participant_name: null, created_at: "2026-09-02T10:00:00Z", duration: 1 },
  {
    id: "c3333333-cccc",
    participant_name: "Locked",
    created_at: "2026-09-03T10:00:00Z",
    duration: 9,
  },
];
// A recording stopped mid-upload can leave an empty last chunk; a corrupt one won't decode.
const DAMAGED = [
  {
    id: "c4444444-dddd",
    participant_name: "Partly",
    created_at: "2026-09-04T10:00:00Z",
    duration: null,
  },
  {
    id: "c5555555-eeee",
    participant_name: "Empty",
    created_at: "2026-09-05T10:00:00Z",
    duration: null,
  },
];
const CHUNKS: Record<string, Chunk[]> = {
  // The webm and the mp3 decode to different rates and channel counts, and the chunk
  // without a path has no audio to fetch.
  "c1111111-aaaa": [
    { id: "k1", path: "a.webm", timestamp: "2026-09-01T10:00:00Z", file: "two-seconds.webm" },
    { id: "k2", path: null, timestamp: "2026-09-01T10:00:02Z" },
    { id: "k3", path: "b.mp3", timestamp: "2026-09-01T10:00:03Z", file: "one-second.mp3" },
  ],
  "c2222222-bbbb": [
    { id: "k4", path: "c.mp3", timestamp: "2026-09-02T10:00:00Z", file: "one-second.mp3" },
  ],
  "c3333333-cccc": [{ id: "k5", path: null, timestamp: "2026-09-03T10:00:00Z" }],
  "c4444444-dddd": [
    { id: "k6", path: "d.mp3", timestamp: "2026-09-04T10:00:00Z", file: "one-second.mp3" },
    { id: "k7", path: "e.mp4", timestamp: "2026-09-04T10:00:01Z", file: "garbage.mp4" },
    { id: "k8", path: "f.mp4", timestamp: "2026-09-04T10:00:02Z", file: "empty.mp4" },
  ],
  "c5555555-eeee": [
    { id: "k9", path: "g.mp4", timestamp: "2026-09-05T10:00:00Z", file: "empty.mp4" },
  ],
};

let api: ReturnType<typeof Bun.serve>;
let requests: { method: string; path: string; params: URLSearchParams; auth: string | null }[];
// More projects than fit on one page, the second one last, so the script has to follow has_more.
const WORKSPACE_PROJECTS = [
  PROJECTS[0]!,
  ...Array.from({ length: 99 }, (_, i) => ({ id: `filler-${i}`, name: `Filler ${i}` })),
  PROJECTS[1]!,
];

function fakeApi(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  requests.push({
    method: req.method,
    path,
    params: url.searchParams,
    auth: req.headers.get("authorization"),
  });

  if (path.startsWith("/files/"))
    return new Response(Bun.file(join(root, path.slice("/files/".length))));
  if (path.startsWith("/directus/") || path.startsWith("/api/auth/")) return signIn(req, path);
  if (req.headers.get("authorization") !== "Bearer good-token")
    return Response.json({ error: "unauthorized" }, { status: 401 });

  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (path === "/api/v2/workspaces") return Response.json({ workspaces: [WORKSPACE] });
  if (path === `/api/v2/workspaces/${WORKSPACE.id}/projects`) {
    const projects = WORKSPACE_PROJECTS.slice(offset, offset + limit);
    return Response.json({ projects, has_more: offset + limit < WORKSPACE_PROJECTS.length });
  }
  const project = path.match(/^\/api\/v2\/projects\/([^/]+)$/);
  if (project) return Response.json(PROJECTS.find((p) => p.id === project[1]));
  if (path === "/api/v2/bff/conversations") {
    const forProject =
      { [PROJECTS[0]!.id]: CONVERSATIONS, [PROJECTS[2]!.id]: DAMAGED }[
        url.searchParams.get("project_id") ?? ""
      ] ?? [];
    return Response.json(forProject.slice(offset));
  }
  const chunks = path.match(/^\/api\/v2\/bff\/conversations\/([^/]+)\/chunks$/);
  if (chunks) return Response.json((CHUNKS[chunks[1]!] ?? []).slice(offset));
  const content = path.match(/^\/api\/conversations\/([^/]+)\/chunks\/([^/]+)\/content$/);
  if (content) {
    const chunk = CHUNKS[content[1]!]?.find((c) => c.id === content[2]);
    if (!chunk?.file) return new Response("no audio", { status: 404 });
    // The real API hands back a presigned URL whose path ends in the chunk's extension.
    return Response.json(`http://127.0.0.1:${api.port}/files/${chunk.file}?X-Amz-Signature=abc`);
  }
  return new Response(`no route ${path}`, { status: 404 });
}

async function signIn(req: Request, path: string): Promise<Response> {
  const body = (await req.json()) as Record<string, string>;
  if ("password" in body && body.password !== "hunter2")
    return Response.json({ errors: [{ message: "bad" }] }, { status: 401 });
  if (path === "/directus/auth/login") {
    if (body.otp === undefined)
      return Response.json({ errors: [{ extensions: { code: "INVALID_OTP" } }] }, { status: 401 });
    if (body.otp !== "123456")
      return Response.json({ errors: [{ message: "bad otp" }] }, { status: 401 });
    return Response.json({ data: { access_token: "good-token" } });
  }
  if (path === "/api/auth/sign-in/email") {
    if (req.headers.get("origin") !== "http://localhost:5173")
      return Response.json({ message: "bad origin" }, { status: 403 });
    return Response.json(
      { twoFactorRedirect: true },
      { headers: { "set-cookie": "two_factor=pending; Path=/; HttpOnly" } },
    );
  }
  if (path === "/api/auth/two-factor/verify-totp") {
    if (req.headers.get("cookie") !== "two_factor=pending" || body.code !== "654321")
      return Response.json({ message: "bad code" }, { status: 401 });
    return Response.json({}, { headers: { "set-auth-token": "good-token" } });
  }
  return new Response("no route", { status: 404 });
}

async function ffmpeg(...args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", ...args], {
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await p.exited).toBe(0);
}

async function probeSeconds(file: string) {
  const p = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    {
      stdout: "pipe",
    },
  );
  return Number((await new Response(p.stdout).text()).trim());
}

let runs = 0;

/** Runs the script with `input` piped to stdin; each run writes into its own out dir. */
async function run(args: string[], input = "", outDir = join(root, `out-${++runs}`)) {
  const env = { ...process.env };
  delete env.DEMBRANE_TOKEN;
  const proc = Bun.spawn(
    ["bun", script, "--api-url", `http://127.0.0.1:${api.port}/api/`, "--out-dir", outDir, ...args],
    { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, outDir };
}

/** Runs the script in a terminal, as a person would, and sends `keys` once `prompt` shows. */
async function runInTerminal(args: string[], prompt: string, keys: string) {
  let output = "";
  const decoder = new TextDecoder();
  const proc = Bun.spawn(
    ["bun", script, "--api-url", `http://127.0.0.1:${api.port}/api/`, ...args],
    {
      terminal: {
        cols: 200,
        rows: 50,
        data: (_terminal, data) => {
          output += decoder.decode(data);
        },
      },
    },
  );
  try {
    while (!output.includes(prompt)) {
      if (proc.exitCode !== null) throw new Error(`Exited before "${prompt}":\n${output}`);
      await Bun.sleep(20);
    }
    proc.terminal?.write(keys);
    const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "still running")]);
    return { code, output };
  } finally {
    proc.kill();
  }
}

/** Every file under the run's out dir, relative to it. */
function files(outDir: string) {
  try {
    return (readdirSync(outDir, { recursive: true }) as string[]).sort();
  } catch {
    return [];
  }
}

(Bun.which("ffmpeg") && Bun.which("ffprobe") ? describe : describe.skip)(
  "download-conversation-audio",
  () => {
    beforeAll(async () => {
      api = Bun.serve({ port: 0, fetch: fakeApi });
      await ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-ac",
        "2",
        "-c:a",
        "libopus",
        join(root, "two-seconds.webm"),
      );
      await ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=1",
        "-ar",
        "44100",
        join(root, "one-second.mp3"),
      );
      writeFileSync(join(root, "empty.mp4"), "");
      writeFileSync(join(root, "garbage.mp4"), "not audio at all");
    });
    afterAll(() => api.stop(true));
    beforeEach(() => {
      requests = [];
    });

    test("a dashboard conversation link downloads that conversation as one file", async () => {
      const link = `https://dashboard.echo-next.dembrane.com/w/${WORKSPACE.id}/projects/${PROJECTS[0]!.id}/conversations/c1111111-aaaa/overview`;
      const { code, stderr, outDir } = await run([link, "--token", "good-token"]);
      expect(stderr).toBe("");
      expect(code).toBe(0);

      // The project's folder and the conversation's file carry their names, short ids and,
      // for the file, the joined duration: 2s of webm and 1s of mp3, the empty chunk left out.
      expect(files(outDir)).toEqual([
        "Town_hall-p1111111",
        "Town_hall-p1111111/Ana_María-c1111111-0m03s.mp3",
      ]);
      const seconds = await probeSeconds(
        join(outDir, "Town_hall-p1111111/Ana_María-c1111111-0m03s.mp3"),
      );
      expect(seconds).toBeGreaterThan(2.9);
      expect(seconds).toBeLessThan(3.2);

      // Only that conversation's chunks are fetched, asked for in timestamp order.
      const listed = requests.filter((r) => r.path.endsWith("/chunks"));
      expect(listed.map((r) => r.path)).toEqual(["/api/v2/bff/conversations/c1111111-aaaa/chunks"]);
      expect(listed[0]!.params.get("sort")).toBe("timestamp");
      const content = requests.filter((r) => r.path.endsWith("/content"));
      expect(content.map((r) => r.path)).toEqual([
        "/api/conversations/c1111111-aaaa/chunks/k1/content",
        "/api/conversations/c1111111-aaaa/chunks/k3/content",
      ]);
      expect(content.every((r) => r.params.get("return_url") === "true")).toBe(true);
      // The token goes to the API, not to the presigned storage URL.
      expect(
        requests
          .filter((r) => r.path.startsWith("/api/"))
          .every((r) => r.auth === "Bearer good-token"),
      ).toBe(true);
      expect(
        requests.filter((r) => r.path.startsWith("/files/")).every((r) => r.auth === null),
      ).toBe(true);
    }, 30_000);

    test("with nothing given it walks workspace, project and conversations from stdin", async () => {
      // One workspace is taken without asking. Projects span two pages; a bad pick is
      // asked again. "2" is the unnamed conversation.
      const { code, stdout, stderr, outDir } = await run(
        ["--token", "good-token"],
        "102\n1\nnope\n2\n",
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Workspace: Team");
      expect(stdout).toContain("Town hall");
      expect(stdout).toContain(" 101. Other");
      expect(stderr).toContain("Out of range: 102");
      expect(stderr).toContain("Not a number or range: nope");
      expect(files(outDir)).toEqual([
        "Town_hall-p1111111",
        "Town_hall-p1111111/conversation-c2222222-0m01s.mp3",
      ]);
    }, 30_000);

    test("--all takes every conversation and skips one whose chunks are hidden", async () => {
      const { code, stderr, outDir } = await run([
        PROJECTS[0]!.id,
        "--all",
        "--token",
        "good-token",
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain("c3333333-cccc: no chunks with audio");
      expect(files(outDir)).toEqual([
        "Town_hall-p1111111",
        "Town_hall-p1111111/Ana_María-c1111111-0m03s.mp3",
        "Town_hall-p1111111/conversation-c2222222-0m01s.mp3",
      ]);
    }, 30_000);

    test("an empty or undecodable chunk is left out of the join", async () => {
      const { code, stdout, outDir } = await run([
        PROJECTS[2]!.id,
        "--all",
        "--token",
        "good-token",
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain("1/3 chunks → ");
      expect(stdout).toContain("(skipped chunk 2 (won't decode), 3 (empty))");
      expect(files(outDir)).toEqual([
        "Damaged-p3333333",
        "Damaged-p3333333/Partly-c4444444-0m01s.mp3",
      ]);
    }, 30_000);

    test("a conversation with no usable chunk fails without stopping the others", async () => {
      const { code, stderr } = await run([PROJECTS[2]!.id, "--all", "--token", "good-token"]);
      expect(code).toBe(0);
      expect(stderr).toContain("Empty-c5555555: failed");
      expect(stderr).toContain("none of the 1 chunks has audio: 1 (empty)");
    }, 30_000);

    test("a rerun into the same folder only fetches what is missing", async () => {
      const outDir = join(root, "rerun");
      const first = await run(
        [PROJECTS[0]!.id, "--conversation", "c2222222-bbbb", "--token", "good-token"],
        "",
        outDir,
      );
      expect(first.code).toBe(0);
      requests = [];
      const args = [
        PROJECTS[0]!.id,
        "--conversation",
        "c2222222-bbbb",
        "--conversation",
        "c1111111-aaaa",
      ];
      const second = await run([...args, "--token", "good-token"], "", outDir);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("conversation-c2222222: already there → ");
      const fetched = requests.filter((r) => r.path.endsWith("/chunks")).map((r) => r.path);
      expect(fetched).toEqual(["/api/v2/bff/conversations/c1111111-aaaa/chunks"]);
      expect(files(outDir)).toEqual([
        "Town_hall-p1111111",
        "Town_hall-p1111111/Ana_María-c1111111-0m03s.mp3",
        "Town_hall-p1111111/conversation-c2222222-0m01s.mp3",
      ]);
    }, 30_000);

    test("--keep-chunks keeps the downloaded chunks but not the decoded wavs", async () => {
      const args = [
        "--project",
        PROJECTS[0]!.id,
        "--conversation",
        "c2222222-bbbb",
        "--keep-chunks",
        "--format",
        "wav",
      ];
      const { code, outDir } = await run([...args, "--token", "good-token"]);
      expect(code).toBe(0);
      expect(files(outDir)).toEqual([
        "Town_hall-p1111111",
        "Town_hall-p1111111/conversation-c2222222-0m01s.wav",
        "Town_hall-p1111111/conversation-c2222222-chunks",
        "Town_hall-p1111111/conversation-c2222222-chunks/0001-k4.mp3",
      ]);
    }, 30_000);

    test("a token copied from a cookie is decoded and loses its Bearer prefix", async () => {
      const { code } = await run([
        PROJECTS[0]!.id,
        "--conversation",
        "c2222222-bbbb",
        "--token",
        "Bearer good%2Dtoken",
      ]);
      expect(code).toBe(0);
      expect(requests.find((r) => r.path.startsWith("/api/"))?.auth).toBe("Bearer good-token");
    }, 30_000);

    test("Ctrl+C at a picker quits instead of asking again", async () => {
      const { code, output } = await runInTerminal(["--token", "good-token"], "Which?", "\x03");
      expect(code).toBe(130);
      expect(output).not.toContain("Aborted with Ctrl+C");
    });

    test("signs in to Directus, asking for a 2FA code when it wants one", async () => {
      const args = [PROJECTS[0]!.id, "--conversation", "c2222222-bbbb", "--target", "prod"];
      const directus = `http://127.0.0.1:${api.port}/directus`;
      const { code, stdout } = await run(
        [...args, "--directus-url", directus],
        "me@example.com\nhunter2\n123456\n",
      );
      expect(code).toBe(0);
      expect(stdout).toContain("2FA code:");
      expect(requests.filter((r) => r.path === "/directus/auth/login")).toHaveLength(2);
    }, 30_000);

    test("signs in to the local API through its two-factor step", async () => {
      const args = [PROJECTS[0]!.id, "--conversation", "c2222222-bbbb", "--target", "local"];
      const { code, stderr, outDir } = await run(args, "me@example.com\nhunter2\n654321\n");
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(files(outDir)).toContain("Town_hall-p1111111/conversation-c2222222-0m01s.mp3");
    }, 30_000);

    test("a failed sign-in stops before anything is listed", async () => {
      const { code, stderr } = await run(
        [PROJECTS[0]!.id, "--target", "local"],
        "me@example.com\nwrong\n",
      );
      expect(code).toBe(1);
      expect(stderr).toContain("Sign-in failed (401)");
      expect(requests.some((r) => r.path.startsWith("/api/v2/"))).toBe(false);
    });

    test("a rejected token says it may be expired or for another target", async () => {
      const { code, stderr } = await run([PROJECTS[0]!.id, "--token", "stale"]);
      expect(code).toBe(1);
      expect(stderr).toContain("→ 401 (token expired or wrong for this target?)");
    });

    test("a conversation outside the project is refused", async () => {
      const { code, stderr, outDir } = await run([
        PROJECTS[0]!.id,
        "--conversation",
        "c9999999",
        "--token",
        "good-token",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain(`Conversation c9999999 is not in project ${PROJECTS[0]!.id}`);
      expect(files(outDir)).toEqual([]);
    });

    test("a project with no conversations stops there", async () => {
      const { code, stderr } = await run([PROJECTS[1]!.id, "--token", "good-token"]);
      expect(code).toBe(1);
      expect(stderr).toContain(`No conversations in project ${PROJECTS[1]!.id}`);
    });

    test("a link from an unknown host needs --target", async () => {
      const { code, stderr } = await run([
        "https://example.com/w/x/projects/y",
        "--token",
        "good-token",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("Don't know which target example.com is; pass --target");
    });

    test("an unknown --target is refused", async () => {
      const { code, stderr } = await run(["--target", "staging", "--token", "good-token"]);
      expect(code).toBe(1);
      expect(stderr).toContain("Unknown --target staging; use prod, next, local");
    });

    test("--help prints usage; two positionals print it and fail", async () => {
      expect(await run(["--help"])).toMatchObject({
        code: 0,
        stdout: expect.stringContaining("Usage:"),
      });
      expect(await run(["a", "b"])).toMatchObject({
        code: 1,
        stdout: expect.stringContaining("Usage:"),
      });
    });
  },
);
