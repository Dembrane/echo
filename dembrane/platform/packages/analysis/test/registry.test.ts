import { expect, test } from "bun:test";
import "../src/recipes";
import { contentHash } from "../src/hashing";
import { getRecipe, listRecipes, recipeDefinition, recipeMetadata } from "../src/registry";
import python from "./fixtures/python-recipes.json" with { type: "json" };

// Every run captures its recipe's definition and hashes it into its fingerprints, so a
// recipe must describe itself exactly as the Python registry did for the same version.
const byId = new Map((python as Record<string, unknown>[]).map((r) => [String(r.id), r]));

test("recipe metadata matches the Python registry for every ported recipe", () => {
  for (const recipe of listRecipes()) {
    const expected = byId.get(recipe.id);
    if (!expected) continue; // the fact-check assessment recipe is internal and not listed
    expect(recipeMetadata(recipe)).toEqual(expected as never);
  }
});

test("definition hashes are stable", () => {
  const def = recipeDefinition(getRecipe("arguments"));
  expect(contentHash(def)).toBe(
    contentHash(
      (({
        id,
        version,
        hashVersion,
        inputTypes,
        outputTypes,
        steps,
        validationRules,
        identityPolicy,
        embeddingProjections,
      }) => ({
        id,
        version,
        hashVersion,
        inputTypes,
        outputTypes,
        steps,
        validationRules,
        identityPolicy,
        embeddingProjections,
      }))(byId.get("arguments") as never),
    ),
  );
});
