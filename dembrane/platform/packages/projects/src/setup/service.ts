import type { Access } from "@dembrane/access";
import { requireAiBudgetForWorkspace } from "@dembrane/allowance";
import { UnavailableError } from "@dembrane/core";
import { type Signed, workspaceFor } from "@dembrane/http";
import type { Completer } from "@dembrane/llm";
import { type Logger, withPayer } from "@dembrane/observability";
import type { Limit, RateLimiter } from "@dembrane/ratelimit";
import { projectTemplate } from "../project-templates";
import type { ProjectsStorage } from "../storage";
import { PageFetchError } from "./fetch-page";
import { askSetupModel, type ModelAnswer, researchTopic, type TemplateFacts } from "./model";
import { cleanKeyTerms, MAX_KEY_TERMS, type ProposedTerm, parseKeyTerms } from "./rules";
import { cleanSettings, PROPOSABLE_FIELDS, type ProposedSetting, templateValue } from "./settings";

/**
 * Setup suggestions (ECHO-1043): from what a host says about a session, before the project
 * exists, the key terms transcription should know and the few settings worth changing on
 * top of the chosen template. Nothing is written: the host accepts what they want and the
 * create request (or the portal editor's save) carries it.
 */

export interface ProjectSetupDeps {
  readonly store: ProjectsStorage;
  readonly db: Parameters<typeof requireAiBudgetForWorkspace>[0];
  readonly access: Access;
  readonly completer: Completer;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** Reads a linked page on our own server (fetch-page.ts); tests hand in their own. */
  readonly fetchPage: (url: string) => Promise<string>;
  /**
   * PROJECT_SETUP_WEB_SEARCH, and only where the provider grounds with search: lets the
   * model look up the organisation or topic the host names.
   */
  readonly webSearch: boolean;
  readonly now: () => Date;
}

export interface SuggestionRequest {
  readonly template_key: string;
  readonly name: string;
  readonly description: string | null;
  readonly source_text: string | null;
  readonly source_url: string | null;
  readonly language: string;
  readonly existing_key_terms: readonly string[] | null;
  readonly include_settings: boolean;
}

export type SuggestionNote = "url_not_read" | "at_cap";

export interface SuggestionResponse {
  readonly key_terms: ProposedTerm[];
  readonly settings: {
    field: string;
    proposed: boolean | string;
    current: boolean | string;
    reason: string;
  }[];
  readonly notes: SuggestionNote[];
  readonly max_key_terms: number;
}

/** Per person: enough for a host trying a few wordings, not for a script. */
export const SUGGESTIONS_LIMIT: Limit = {
  name: "project_setup_suggestions",
  capacity: 20,
  windowSeconds: 3600,
};

function factsOf(templateKey: string): TemplateFacts {
  const t = projectTemplate(templateKey);
  return Object.fromEntries(PROPOSABLE_FIELDS.map((f) => [f, templateValue(t, f)]));
}

export async function suggestProjectSetup(
  d: ProjectSetupDeps,
  who: Signed,
  workspaceId: string,
  body: SuggestionRequest,
): Promise<SuggestionResponse> {
  // Who may ask: whoever may create a project here. Then the per-person limit, then the
  // workspace's AI budget (the 402 every AI feature answers when it is spent).
  await workspaceFor(
    d.access,
    who,
    workspaceId,
    "project:create",
    (id) => d.store.workspaceExists(id),
    "Not allowed",
  );
  const template = projectTemplate(body.template_key);
  await d.limiter.checkUser(SUGGESTIONS_LIMIT, who.directusUserId ?? who.appUserId ?? "");
  await requireAiBudgetForWorkspace(d.db, workspaceId, d.now());

  const existing = parseKeyTerms(body.existing_key_terms);
  const notes: SuggestionNote[] = [];
  if (existing.length >= MAX_KEY_TERMS) notes.push("at_cap");

  let pageText = "";
  if (body.source_url?.trim()) {
    try {
      pageText = await d.fetchPage(body.source_url);
    } catch (err) {
      // Soft: the other inputs still make suggestions. The reason is logged, never the URL
      // or anything read from it.
      notes.push("url_not_read");
      d.logger.info(
        {
          signal: "project_setup.page_unread",
          reason: err instanceof PageFetchError ? err.reason : "error",
        },
        "the linked page for setup suggestions could not be read",
      );
    }
  }

  const name = body.name.trim();
  const description = body.description?.trim() ?? "";
  const sourceText = body.source_text?.trim() ?? "";
  const payer = { ref: "workspace", id: workspaceId } as const;

  let answer: ModelAnswer | null;
  try {
    answer = await withPayer(payer, async () => {
      let background = "";
      if (d.webSearch && (name || description)) {
        // A failed look-up never costs the host their suggestions.
        background = await researchTopic(d.completer, { name, description }).catch((err) => {
          d.logger.warn({ err, signal: "project_setup.search_failed" }, "setup search failed");
          return "";
        });
      }
      return askSetupModel(d.completer, {
        templateKey: template.key,
        templateFacts: factsOf(template.key),
        name,
        description,
        sourceText,
        pageText,
        existingTerms: existing,
        language: body.language,
        includeSettings: body.include_settings,
        ...(background && { background }),
      });
    });
  } catch (err) {
    d.logger.warn({ err, signal: "project_setup.model_failed" }, "setup suggestions failed");
    throw new UnavailableError("project.setup_suggestions_unavailable");
  }
  if (!answer) throw new UnavailableError("project.setup_suggestions_unavailable");

  // Terms must occur in what the host gave or the page we read: the project name and the
  // description count as the host's description.
  const { terms } = cleanKeyTerms(answer.key_terms, {
    sources: {
      description: [name, description].filter(Boolean).join("\n"),
      text: sourceText,
      url: pageText,
    },
    existing,
    language: body.language,
  });
  const settings: ProposedSetting[] = body.include_settings
    ? cleanSettings(answer.settings, template)
    : [];
  return {
    key_terms: terms,
    settings: settings.map((s) => ({
      field: s.field,
      proposed: s.proposed,
      current: s.current,
      reason: s.reason,
    })),
    notes,
    max_key_terms: MAX_KEY_TERMS,
  };
}
