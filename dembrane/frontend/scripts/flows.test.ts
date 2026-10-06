import { describe, expect, it } from "vitest";
import { flows } from "../e2e/flows";
import { routerPaths } from "../e2e/routes";

// The flow map's coverage gate: every page src/Router.tsx can route to has an
// entry in e2e/flows.ts (a visit or a skip with its reason), and every entry is
// still a page. Add a route, add its flow.
describe("flow map", () => {
	const paths = [...new Set(routerPaths().map((r) => r.path))];

	it("reads the whole router", () => {
		// A change in Router.tsx's shape that loses routes would make the gate
		// trivially green; the app has well over seventy pages.
		expect(paths.length).toBeGreaterThan(70);
	});

	it("has an entry for every router path", () => {
		expect(paths.filter((p) => !(p in flows))).toEqual([]);
	});

	it("has no entry for a path the router lost", () => {
		expect(Object.keys(flows).filter((p) => !paths.includes(p))).toEqual([]);
	});

	it("skips with a reason, or says how to fill every param", () => {
		const unfilled = Object.entries(flows).flatMap(([p, flow]) =>
			flow.skip
				? []
				: [...p.matchAll(/:(\w+)|(\*)/g)]
						.map((m) => m[1] ?? m[2])
						.filter((name) => !(name in (flow.params ?? {})))
						.map((name) => `${p} ${name}`),
		);
		expect(unfilled).toEqual([]);
	});
});
