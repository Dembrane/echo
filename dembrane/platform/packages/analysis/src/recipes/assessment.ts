import type { Json } from "../contracts";
import {
  type ExecutorDeps,
  executeInline,
  type RecipeContext,
  RecipeFailed,
  stepResult,
} from "../executor";
import { contentHash } from "../hashing";
import { claimOf } from "../mapview";
import type { Recipe } from "../registry";
import { required, s, withDefault } from "../schema";
import { normalizeText } from "../text";
import { AssessmentSource } from "../types";

/**
 * A completed fact-check of one exact claim revision, recorded as a fact_check_assessment
 * revision with an `assesses` relation to that revision: a deterministic record of the
 * answer the worker already has, never a second model call. It runs only from the
 * fact-check feature, so the runs API refuses it by name.
 */

export const ASSESSMENT_RECIPE_ID = "map.fact_check_assessment";
export const ASSESSMENT_RECIPE_VERSION = "fact-check-assessment-v1";

async function execute(ctx: RecipeContext): Promise<void> {
  const [claim] = await ctx.inputRevisions();
  if (!claim) throw new RecipeFailed("The claim changed before its check was recorded.");
  const parameters = { ...ctx.parameters };
  const checked = await ctx.step<Json>(
    "statement-matches",
    async () => {
      const found = claimOf(claim);
      const matches =
        found !== null &&
        normalizeText(found[0]) === normalizeText(parameters.statement) &&
        found[2] === parameters.claimKey;
      return stepResult({
        output: { matches },
        validation: [
          {
            check: "statement-matches",
            status: matches ? "passed" : "failed",
            evidence: { revisionId: claim.id, claimKey: parameters.claimKey },
          },
        ],
      });
    },
    { inputs: { revision: claim.id, claimKey: parameters.claimKey } },
  );
  if (!checked.matches) throw new RecipeFailed("The claim changed before its check was recorded.");
  await ctx.step(
    "record",
    async () =>
      stepResult({
        output: {
          verdict: parameters.verdict,
          justification: parameters.justification,
          sources: parameters.sources,
        },
      }),
    { inputs: { revision: claim.id, answer: contentHash(parameters) } },
  );
  const assessment = await ctx.emit(
    "fact_check_assessment",
    claim.id,
    {
      verdict: parameters.verdict,
      justification: parameters.justification,
      sources: parameters.sources,
      statement: parameters.statement,
      claimKey: parameters.claimKey,
      model: parameters.model ?? null,
      promptVersion: parameters.promptVersion ?? null,
    },
    { inputRevisionIds: [claim.id] },
  );
  await ctx.relate("assesses", assessment, claim, { basis: "extracted" });
}

export const ASSESSMENT_RECIPE: Recipe = {
  id: ASSESSMENT_RECIPE_ID,
  version: ASSESSMENT_RECIPE_VERSION,
  name: "Fact-check assessment",
  purpose: "Records a completed fact-check of one exact claim revision as an assessment of it.",
  inputTypes: ["argument", "deduplicated_argument"],
  steps: [
    {
      key: "statement-matches",
      version: "1",
      kind: "check",
      description: "The checked statement and evidence are this revision's",
      checkVersion: "1",
    },
    {
      key: "record",
      version: "1",
      kind: "deterministic",
      description: "Record the answer the fact-check worker saved",
    },
  ],
  outputTypes: ["fact_check_assessment"],
  execute,
  parameters: {
    name: "AssessmentParameters",
    fields: [
      required("statement", s.str({ min: 1 })),
      required("claimKey", s.str({ min: 1 })),
      required("verdict", s.str({ min: 1 })),
      withDefault("justification", s.str(), ""),
      withDefault("sources", s.list(s.model(AssessmentSource)), () => []),
      withDefault("model", s.opt(s.str()), null),
      withDefault("promptVersion", s.opt(s.str()), null),
    ],
  },
  scopeKeyPattern: /^revision:[0-9a-f-]{36}$/,
  modelConfig: () => ({}),
};

/**
 * Records one completed check of one revision. Returns the run and the publication event
 * id (null when an identical record was reused). A repeat for the same attempt returns the
 * same run, keyed by the check's id and attempt.
 */
export async function recordAssessment(
  deps: ExecutorDeps,
  projectId: string,
  revisionId: string,
  check: Json,
): Promise<{ runId: string; status: string; eventId: string | null }> {
  const outcome = await executeInline(
    {
      projectId,
      recipeId: ASSESSMENT_RECIPE_ID,
      scopeKey: `revision:${revisionId}`,
      mode: "refresh",
      parameters: {
        statement: check.statement,
        claimKey: check.claim_key,
        verdict: check.verdict,
        justification: check.justification || "",
        sources: check.sources || [],
        model: check.model ?? null,
        promptVersion: check.prompt_version ?? null,
      },
      selectedRevisionIds: [revisionId],
      idempotencyKey: `map-fact-check:${check.id}:${check.attempt}`,
      requestedBy: (check.requested_by as string | null) ?? null,
    },
    deps,
  );
  const run = outcome.run;
  // Only a run this call created and published has an event of its own to advance the view with.
  const eventId =
    outcome.outcome === "created" && run.status === "ready"
      ? await publicationEvent(deps, run.id)
      : null;
  return { runId: run.id, status: run.status, eventId };
}

async function publicationEvent(deps: ExecutorDeps, runId: string): Promise<string | null> {
  const rows = await deps.store.sql.unsafe(
    "SELECT id::text AS id FROM analysis_outbox WHERE run_id = $1 AND event_type = 'run_published' LIMIT 1",
    [runId],
  );
  return rows[0] ? String(rows[0].id) : null;
}
