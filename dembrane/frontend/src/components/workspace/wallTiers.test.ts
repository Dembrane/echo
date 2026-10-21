import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

const sources = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
	});

// required_tier segments the upgrade funnel; "none" (null) is reserved for billing_page, which is not a wall.
it("every UpgradeModal wall names a tier", () => {
	const nullTier: string[] = [];
	for (const file of sources(SRC)) {
		const text = readFileSync(file, "utf8");
		for (const [mount] of text.matchAll(/<UpgradeModal\b[\s\S]*?\/>/g)) {
			if (!/requiredTier=\{null\}/.test(mount)) continue;
			if (/wallKey="billing_page"/.test(mount)) continue;
			nullTier.push(file.slice(SRC.length + 1));
		}
	}
	expect(nullTier).toEqual([]);
});
