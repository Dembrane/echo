import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The grammar rule of a row of steps: in a row of
// steps (data-steps), Back is the tertiary, text-only button (variant="subtle"); the pill
// stays on the right. The scanner reports it as "flow.steps-back-tertiary".

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "grammar-steps-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const scan = (
	name: string,
	source: string,
	rule = "flow.steps-back-tertiary",
) => {
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
		.filter((l) => l.trim().split(/\s+/)[0] === rule);
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

// A pill with a Back beside it: Back in the left corner, the pill in the right corner. The
// row takes data-steps, and Back comes first in it. The scanner reports "flow.back-corner".

const pair = (
	open: string,
	first: string,
	second: string,
) => `import { Trans } from "@lingui/react/macro";
import { Button, Group } from "@mantine/core";
export const Row = ({ onBack }: { onBack: () => void }) => (
	${open}
		${first}
		${second}
	</Group>
);
`;
const BACK = `<Button variant="subtle" color="gray" onClick={onBack}>
			<Trans>Back</Trans>
		</Button>`;
const PILL = `<Button variant="filled">
			<Trans>Change who signs</Trans>
		</Button>`;

describe("a pill with a Back beside it", () => {
	it("is reported in a row without data-steps", () => {
		expect(
			scan(
				"left.tsx",
				pair('<Group gap="xs">', PILL, BACK),
				"flow.back-corner",
			),
		).toHaveLength(1);
	});

	it("is reported when Back comes after the pill in a row of steps", () => {
		expect(
			scan(
				"order.tsx",
				pair('<Group data-steps justify="space-between">', PILL, BACK),
				"flow.back-corner",
			),
		).toHaveLength(1);
	});

	it("passes with Back first in a row of steps", () => {
		expect(
			scan(
				"corners.tsx",
				pair('<Group data-steps justify="space-between">', BACK, PILL),
				"flow.back-corner",
			),
		).toHaveLength(0);
	});

	it("reads a Back that shares its button with Cancel", () => {
		expect(
			scan(
				"shared.tsx",
				pair(
					"<Group>",
					`<Button variant="subtle" onClick={onBack}>
			{onBack ? <Trans>Back</Trans> : <Trans>Cancel</Trans>}
		</Button>`,
					PILL,
				),
				"flow.back-corner",
			),
		).toHaveLength(1);
	});

	it("leaves Cancel beside the pill at the left", () => {
		expect(
			scan(
				"cancel.tsx",
				pair(
					"<Group>",
					PILL,
					`<Button variant="subtle" color="gray">
			<Trans>Cancel</Trans>
		</Button>`,
				),
				"flow.back-corner",
			),
		).toHaveLength(0);
	});
	it("reads a Back one wrapper deep", () => {
		expect(
			scan(
				"wrapped.tsx",
				pair(
					"<Group>",
					`<Group gap="xs">
			${BACK}
			<Button variant="subtle" color="gray">
				<Trans>Cancel</Trans>
			</Button>
		</Group>`,
					PILL,
				),
				"flow.back-corner",
			),
		).toHaveLength(1);
	});

	it("leaves an inner row that holds both to its own check", () => {
		expect(
			scan(
				"inner.tsx",
				pair(
					'<Group justify="flex-end">',
					"<span />",
					`<Group data-steps justify="space-between">
			${BACK}
			${PILL}
		</Group>`,
				),
				"flow.back-corner",
			),
		).toHaveLength(0);
	});
});
