import { requireAiBudgetForWorkspace } from "@dembrane/allowance";
import { BadRequestError, UnavailableError } from "@dembrane/core";
import { type Signed, workspaceFor } from "@dembrane/http";
import { withPayer } from "@dembrane/observability";
import type { Limit } from "@dembrane/ratelimit";
import { projectTemplate } from "../project-templates";
import {
  askDigestModel,
  CONDENSED_MAX_CHARS,
  condenseSource,
  type DigestAnswer,
  type DigestSource,
} from "./digest-model";
import { cleanDigest, type DigestResult, fieldsReturned } from "./digest-rules";
import { PageFetchError } from "./fetch-page";
import { MAX_KEY_TERMS, type NamedSource, parseKeyTerms } from "./rules";
import type { ProjectSetupDeps } from "./service";

/**
 * The context digest (ECHO-1055): a host drops an agenda, an invitation, slides or a brief
 * on the template picker and dembrane proposes the whole setup: name, goal, context, key
 * terms, the template, rounds as tags, Verify topics, an Explore prompt and host script
 * steps. Files never reach the server: the browser extracts their text and sends that, a
 * file name, a kind and nothing else. Nothing is stored here: the host reviews, edits and
 * creates, and the create request carries what they kept.
 *
 * Steps: read the link (guarded, as suggestions do), condense each long source with one
 * model call, then one schema-constrained call over everything, then the rules in code
 * (digest-rules.ts). Every bound that cuts material says so in `notes`; nothing is dropped
 * silently. Logs carry counts and reasons only, never text, names or the link.
 */

/** Per person: each digest is several model calls, so fewer than suggestions' 20. */
export const DIGEST_LIMIT: Limit = {
  name: "project_setup_digest",
  capacity: 10,
  windowSeconds: 3600,
};

export const DIGEST_BOUNDS = {
  /** Sources in one request: five files, pasted text and a link. */
  maxSources: 7,
  /** Extracted text in one request, all sources together (the browser holds to it too). */
  totalChars: 200_000,
  /** A source longer than this is condensed first. */
  condenseFrom: 6_000,
  /** The most of one source a condensing call reads. */
  condenseInput: 100_000,
  /** The most text the digest call reads, condensed sources included. */
  digestInput: 30_000,
} as const;

export type DigestNote =
  | "url_not_read"
  | "material_cut"
  | "nothing_found"
  | "personal_data_removed"
  | "at_cap";

export interface DigestRequest {
  readonly sources: readonly {
    name: string;
    kind: "file" | "text" | "url";
    text: string | null;
    url: string | null;
  }[];
  readonly language: string;
  readonly existing: {
    name: string | null;
    context: string | null;
    key_terms: readonly string[] | null;
  } | null;
}

export interface DigestResponse extends DigestResult {
  readonly notes: DigestNote[];
  readonly sources: { name: string; kind: string; chars: number; condensed: boolean }[];
  readonly max_key_terms: number;
}

/** Names a host recognises, each once: a second "agenda.pdf" is "agenda.pdf (2)". */
function uniqueName(raw: string, taken: Set<string>): string {
  const base =
    raw
      .replace(/[\r\n<>]+/g, " ")
      .trim()
      .slice(0, 120) || "Source";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
  taken.add(name);
  return name;
}

/** The text a source's start keeps when it has to be cut, at a line where it can. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const line = cut.lastIndexOf("\n");
  return line > max * 0.6 ? cut.slice(0, line) : cut;
}

export async function digestProjectSetup(
  d: ProjectSetupDeps,
  who: Signed,
  workspaceId: string,
  body: DigestRequest,
): Promise<DigestResponse> {
  // The same gates as suggestions: may create a project here, the per-person limit, then
  // the workspace's AI budget.
  await workspaceFor(
    d.access,
    who,
    workspaceId,
    "project:create",
    (id) => d.store.workspaceExists(id),
    "Not allowed",
  );
  if (!body.sources.length || body.sources.length > DIGEST_BOUNDS.maxSources)
    throw new BadRequestError("request.field_required", { params: { field: "sources" } });
  body.sources.forEach((s, i) => {
    const field = s.kind === "url" ? "url" : "text";
    if (!(s.kind === "url" ? s.url : s.text)?.trim())
      throw new BadRequestError("request.field_required", {
        params: { field: `sources[${i}].${field}` },
      });
  });
  await d.limiter.checkUser(DIGEST_LIMIT, who.directusUserId ?? who.appUserId ?? "");
  await requireAiBudgetForWorkspace(d.db, workspaceId, d.now());
  return withPayer({ ref: "workspace", id: workspaceId } as const, () => digestMaterial(d, body));
}

/**
 * The digest itself, after the gates: what the quality check (test/digest-quality) runs
 * with a fake or a real model. Every model call happens inside the caller's payer.
 */
export async function digestMaterial(
  d: Pick<ProjectSetupDeps, "completer" | "fetchPage" | "logger">,
  body: DigestRequest,
): Promise<DigestResponse> {
  const started = Date.now();
  const notes = new Set<DigestNote>();
  const existingTerms = parseKeyTerms(body.existing?.key_terms ?? null);
  if (existingTerms.length >= MAX_KEY_TERMS) notes.add("at_cap");

  // The material, by name, in the order the host gave it; the link read on our server.
  const taken = new Set<string>();
  const originals: { name: string; kind: DigestSource["kind"]; text: string }[] = [];
  let total = 0;
  for (const s of body.sources) {
    let text = "";
    if (s.kind === "url") {
      try {
        text = await d.fetchPage(s.url ?? "");
      } catch (err) {
        notes.add("url_not_read");
        d.logger.info(
          {
            signal: "project_setup.digest_page_unread",
            reason: err instanceof PageFetchError ? err.reason : "error",
          },
          "the linked page for the digest could not be read",
        );
        continue;
      }
    } else text = (s.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const room = DIGEST_BOUNDS.totalChars - total;
    if (room <= 0) {
      notes.add("material_cut");
      continue;
    }
    if (text.length > room) {
      notes.add("material_cut");
      text = headOf(text, room);
    }
    total += text.length;
    originals.push({ name: uniqueName(s.name || s.url || s.kind, taken), kind: s.kind, text });
  }
  const existingContext = body.existing?.context?.trim() ?? "";
  const existingName = body.existing?.name?.trim() ?? "";
  if (!originals.length && !existingContext) {
    notes.add("nothing_found");
    return {
      key_terms: [],
      provenance: {},
      notes: [...notes],
      sources: [],
      max_key_terms: MAX_KEY_TERMS,
    };
  }

  let answer: DigestAnswer | null;
  let modelSources: DigestSource[];
  try {
    ({ answer, modelSources } = await (async () => {
      // Condense the long sources, in parallel; a failed call keeps the source's start.
      const condensed = await Promise.all(
        originals.map(async (o): Promise<DigestSource> => {
          if (o.text.length <= DIGEST_BOUNDS.condenseFrom)
            return { name: o.name, kind: o.kind, text: o.text, condensed: false };
          if (o.text.length > DIGEST_BOUNDS.condenseInput) notes.add("material_cut");
          const input = headOf(o.text, DIGEST_BOUNDS.condenseInput);
          const text = await condenseSource(d.completer, { name: o.name, text: input }).catch(
            (err) => {
              d.logger.warn(
                { err, signal: "project_setup.digest_condense_failed" },
                "condense failed",
              );
              notes.add("material_cut");
              return headOf(o.text, CONDENSED_MAX_CHARS);
            },
          );
          return { name: o.name, kind: o.kind, text, condensed: true };
        }),
      );
      // Bound what the digest call reads: each source gets an even share of what is left.
      let budget = DIGEST_BOUNDS.digestInput;
      const ordered = [...condensed]
        .filter((s) => s.text)
        .sort((a, b) => a.text.length - b.text.length);
      const fitted = new Map<string, DigestSource>();
      ordered.forEach((s, i) => {
        const share = Math.floor(budget / (ordered.length - i));
        const text = s.text.length > share ? headOf(s.text, share) : s.text;
        if (text.length < s.text.length) notes.add("material_cut");
        budget -= text.length;
        fitted.set(s.name, { ...s, text });
      });
      const sources = condensed.flatMap((s) => fitted.get(s.name) ?? []);
      const result = await askDigestModel(d.completer, {
        sources,
        language: body.language,
        existing: {
          ...(existingName && { name: existingName }),
          ...(existingContext && { context: headOf(existingContext, 4_000) }),
          keyTerms: existingTerms,
        },
      });
      return { answer: result, modelSources: condensed };
    })());
  } catch (err) {
    d.logger.warn({ err, signal: "project_setup.digest_failed" }, "the digest failed");
    throw new UnavailableError("project.setup_suggestions_unavailable");
  }
  if (!answer) throw new UnavailableError("project.setup_suggestions_unavailable");

  // Terms and snippets must occur in what the host gave: the original sources (not the
  // condensed ones), and the project's name and context they already wrote.
  const named: NamedSource[] = [
    ...originals.map((o) => ({ name: o.name, text: o.text })),
    ...(existingName || existingContext
      ? [
          {
            name: "Project context",
            text: [existingName, existingContext].filter(Boolean).join("\n"),
          },
        ]
      : []),
  ];
  const { personal_data_removed, ...result } = cleanDigest({
    answer,
    sources: named,
    existingTerms,
    language: body.language,
    templateOf: (key) => {
      try {
        return projectTemplate(key);
      } catch {
        return null;
      }
    },
  });
  if (personal_data_removed) notes.add("personal_data_removed");
  const fields = fieldsReturned(result);
  if (!fields.length) notes.add("nothing_found");
  d.logger.info(
    {
      signal: "project_setup.digest_ready",
      sources: originals.length,
      condensed: modelSources.filter((s) => s.condensed).length,
      fields: fields.length,
      notes: [...notes],
      ms: Date.now() - started,
    },
    "a digest was prepared",
  );
  return {
    ...result,
    notes: [...notes],
    sources: originals.map((o) => ({
      name: o.name,
      kind: o.kind,
      chars: o.text.length,
      condensed: modelSources.find((m) => m.name === o.name)?.condensed ?? false,
    })),
    max_key_terms: MAX_KEY_TERMS,
  };
}
