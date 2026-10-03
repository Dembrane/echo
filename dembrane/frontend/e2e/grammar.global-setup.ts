import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Each run starts a fresh report; the spec adds to it route by route.
export const REPORT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../test-results/grammar-report.json",
);

export default function globalSetup() {
	mkdirSync(path.dirname(REPORT), { recursive: true });
	rmSync(REPORT, { force: true });
}
