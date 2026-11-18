import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The grammar rule proposed with the data room (dashboard-plan.md, unit 15): in a row of
// steps (data-steps), Back is the tertiary, text-only button (variant="subtle"); the pill
// stays on the right. The scanner reports it as "flow.steps-back-tertiary".

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "grammar-steps-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const scan = (name: string, source: string) => {
	const file = path.join(dir, name);
	writeFileSync(file, source);
	// --scan prints one finding per line: "  <rule>  <file>:<line>  <message>".
	const run = spawnSync(
		process.execPath,
		["scripts/check-grammar.mjs", "--scan", file],
		{ cwd: root, encoding: "utf8" },
	);
	expect(run.stdout).toMatch(/findings in 1 files\./);
	return run.stdout
		.split("\n")
		.filter((l) => l.trim().split(/\s+/)[0] === "flow.steps-back-tertiary");
};

const row = (back: string) => `import { Button, Group } from "@mantine/core";
export const Steps = ({ onBack }: { onBack: () => void }) => (
	<Group data-steps justify="space-between" wrap="nowrap">
		${back}
		<Button variant="filled" type="submit">
			Continue
		</Button>
	</Group>
);
`;

describe("Back in a row of steps", () => {
	it("is reported when it is the default (secondary) button", () => {
		expect(
			scan("secondary.tsx", row("<Button onClick={onBack}>Back</Button>")),
		).toHaveLength(1);
	});

	it("is reported when it is outlined", () => {
		expect(
			scan(
				"outline.tsx",
				row('<Button variant="outline" onClick={onBack}>Back</Button>'),
			),
		).toHaveLength(1);
	});

	it("passes as the tertiary, text-only button", () => {
		expect(
			scan(
				"subtle.tsx",
				row('<Button variant="subtle" onClick={onBack}>Back</Button>'),
			),
		).toHaveLength(0);
	});

	it("leaves a row without data-steps to the other rules", () => {
		expect(
			scan(
				"plain.tsx",
				`import { Button, Group } from "@mantine/core";
export const Plain = () => (
	<Group>
		<Button variant="filled">Save</Button>
		<Button>Cancel</Button>
	</Group>
);
`,
			),
		).toHaveLength(0);
	});
});
