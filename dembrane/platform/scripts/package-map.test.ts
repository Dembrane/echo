import { expect, test } from "bun:test";
import { type Layer, type Pkg, problems, readWorkspace, render, splice } from "./package-map";

const pkg = (
  name: string,
  layer: Layer,
  imports: string[],
  allow: Record<string, string> = {},
): Pkg => ({
  name,
  dir: `${layer === "app" ? "apps" : "packages"}/${name}`,
  layer,
  description: `${name} things.`,
  declared: new Set(imports),
  allow,
  imports: new Set(imports),
  testImports: new Set(),
});

test("a dependency points down only", () => {
  const found = problems([
    pkg("api", "app", ["projects", "db"]),
    pkg("projects", "namespace", ["db"]),
    pkg("chats", "namespace", ["projects", "db"]),
    pkg("db", "capability", ["projects"]),
  ]);
  expect(found).toEqual([
    expect.stringContaining("chats imports the namespace projects"),
    expect.stringContaining("db is a capability and imports the namespace projects"),
  ]);
});

test("an allowed namespace import needs a reason and must still be used", () => {
  expect(
    problems([
      pkg("projects", "namespace", []),
      pkg("chats", "namespace", ["projects"], { projects: "reads the project" }),
    ]),
  ).toEqual([]);
  expect(problems([pkg("chats", "namespace", [], { projects: "reads the project" })])).toEqual([
    "chats allows projects but no longer imports it; remove the entry",
  ]);
});

test("the workspace keeps the rule and PACKAGES.md matches it", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const pkgs = await readWorkspace(root);
  expect(problems(pkgs)).toEqual([]);
  const readme = await Bun.file(`${root}/PACKAGES.md`).text();
  expect(splice(readme, render(pkgs))).toBe(readme);
});
