import { expect, test } from "bun:test";
import { contentHash } from "../src/hashing";
import { promptFingerprint } from "../src/recipes/deduplication";
import {
  type DeduplicationParams,
  deduplicate,
  discoverCandidates,
  discoveryDoc,
  lineageKey,
  resultItems,
  type SourceArgument,
  type VerificationRequest,
  verificationStatus,
  verificationUserText,
} from "../src/recipes/deduplication-core";
import python from "./fixtures/dedup-python.json" with { type: "json" };

/**
 * dedup-python.json is the Python core's output on fixed arguments and recorded verifier
 * answers (dedup-capture.py made it): discovery, the exact prompt text per group, the
 * assembled result, lineage keys and the hashes of the stored artifacts. The TypeScript
 * core must reproduce all of it from the same inputs and answers.
 */

type Case = (typeof python.cases)[number];
const sources = python.sources as unknown as SourceArgument[];
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function paramsOf(c: Case): DeduplicationParams {
  const p = c.params as Record<string, unknown>;
  return {
    embeddingModel: String(p.embedding_model),
    similarityThreshold: (p.similarity_threshold as number | null) ?? null,
    maxGroupSize: Number(p.max_group_size),
    maxCandidateGroups: Number(p.max_candidate_groups),
    concurrency: Number(p.concurrency),
  };
}

test("the prompt file is byte for byte the Python one", () => {
  expect(promptFingerprint()).toBe(python.promptFingerprint);
});

for (const c of python.cases) {
  test(`case ${c.name}: discovery, prompts and result match the Python core`, async () => {
    const params = paramsOf(c);
    const discovery = discoverCandidates(sources, params);
    const doc = discoveryDoc(discovery);
    expect(plain(doc)).toEqual(c.discovery as never);
    expect(contentHash(doc)).toBe(c.discoveryHash);

    const answers = c.answers as Record<string, unknown>;
    const texts: Record<string, string> = {};
    const verifier = async (
      request: VerificationRequest,
    ): Promise<[unknown, Record<string, number>]> => {
      texts[request.group_id] = verificationUserText(request);
      const answer = answers[request.group_id];
      if (answer === null || answer === undefined) throw new RuntimeError("boom");
      return [answer, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, attempts: 1 }];
    };
    const result = await deduplicate(sources, params, verifier);
    expect(texts).toEqual(c.userTexts as never);
    expect(plain(result)).toEqual(c.result as never);
    expect(contentHash(result)).toBe(c.resultHash);
    expect(resultItems(result).map((i) => lineageKey(i.member_object_ids))).toEqual(c.lineageKeys);
    expect(resultItems(result).map((i) => verificationStatus(i.verification))).toEqual(c.statuses);
  });
}

/** Named like Python's builtin, so a failed call records the same "RuntimeError: boom". */
class RuntimeError extends Error {}
