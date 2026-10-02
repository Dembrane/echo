// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
	type InviteableWorkspace,
	WorkspaceSelectList,
} from "./WorkspaceSelectList";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		};
	}
});

afterEach(cleanup);

const ws = (id: string, seats: number): InviteableWorkspace => ({
	id,
	member_count: seats,
	name: `Workspace ${id}`,
	seat_cap: null,
	seat_invite_blocked: false,
	seats_used_including_pending: seats,
	tier: "pro",
});

it("pluralises the uncapped seat count", () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<WorkspaceSelectList
					workspaces={[ws("a", 1), ws("b", 3)]}
					selected={new Set()}
					onToggle={() => {}}
					pendingCount={0}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	expect(screen.getByText("1 seat")).toBeTruthy();
	expect(screen.getByText("3 seats")).toBeTruthy();
	expect(screen.queryByText("1 seats")).toBeNull();
});

it("has no hand-rolled seat plurals left in seat copy", () => {
	const files = [
		"src/components/invite/WorkspaceSelectList.tsx",
		"src/components/invite/InviteModal.tsx",
		"src/components/billing/BillingManager.tsx",
	];
	for (const f of files) {
		const src = readFileSync(resolve(process.cwd(), f), "utf8");
		expect(src, f).not.toMatch(/seat\(s\)/);
		expect(src, f).not.toMatch(/\}\s+seats<\/Trans>/);
	}
});
