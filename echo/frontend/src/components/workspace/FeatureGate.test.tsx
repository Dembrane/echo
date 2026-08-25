// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Tier } from "@/lib/tiers";
import { FeatureGate, UpgradeModal } from "./FeatureGate";
import { FeatureGatePopover } from "./FeatureGatePopover";
import { type WallKey, wallActionLine, wallPopoverLine } from "./gateWalls";

const capture = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		// The price anchor line reads a feature flag. Unresolved here, which is
		// the quiet variant: no number is drawn.
		getFeatureFlag: () => undefined,
		onFeatureFlags: () => () => {},
	},
}));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: {
			id: "workspace-1",
			org_id: "org-1",
			role: "admin",
			tier: "free",
		},
	}),
}));

vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: { email: "someone@example.com" } }),
}));

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
		} as unknown as typeof ResizeObserver;
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

beforeEach(() => {
	sessionStorage.clear();
	capture.mockClear();
});

afterEach(() => {
	cleanup();
});

const wrap = (node: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/workspace"]}>{node}</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const renderModal = ({
	currentTier = "free" as Tier,
	entry = "modal_direct" as "modal_direct" | "popover_link",
	requiredTier = "changemaker" as Tier,
	wallKey,
}: {
	currentTier?: Tier;
	entry?: "modal_direct" | "popover_link";
	requiredTier?: Tier;
	wallKey: WallKey;
}) =>
	wrap(
		<UpgradeModal
			canRequestUpgrade
			currentTier={currentTier}
			entry={entry}
			onClose={() => {}}
			opened
			requiredTier={requiredTier}
			wallKey={wallKey}
			workspaceId="workspace-1"
		/>,
	);

const modalText = () =>
	screen.getByTestId("pricing-configurator-modal").textContent ?? "";

const gateViewedCalls = () =>
	capture.mock.calls.filter((call) => call[0] === "pricing_config_gate_viewed");

// 1. One modal, from every mount point. One line varies: the opening.

it("renders the same modal from two different walls, but for the opening line", () => {
	const first = renderModal({ wallKey: "custom_logo" });
	const custom = modalText();
	expect(custom).toContain("You were trying to add your logo.");
	first.unmount();

	renderModal({ wallKey: "report_cap" });
	expect(modalText()).toContain("You were trying to create another report.");
	// Swap that one line back and the two are the same text.
	expect(modalText().replace("create another report", "add your logo")).toBe(
		custom,
	);
});

it("names the attempt, never the feature or the plan, because the popover named those", () => {
	renderModal({ wallKey: "custom_logo" });
	const text = modalText();

	// The wall is keyed, so the app already knows what they were doing.
	expect(text).toContain("You were trying to add your logo.");
	expect(text).toContain("That requires a paid plan.");
	// The control's own name, the feature list and the other walls stay out.
	expect(text).not.toMatch(/custom logo/i);
	expect(text).not.toMatch(/webhook/i);
	expect(text).not.toMatch(/report/i);
});

// 2. The locked data family is the only exception.

it("puts the cap block above the opening for the transcription cap", () => {
	renderModal({ wallKey: "transcription_cap" });
	const text = modalText();

	expect(text).toContain("Your free transcription hour is used up.");
	expect(text).toContain(
		"The portals will keep working! Your participants are never cut off and nothing they say is lost.",
	);
	// The cap block sits above the opening, not below it.
	expect(text.indexOf("Your free transcription hour is used up.")).toBeLessThan(
		text.indexOf("You were trying to"),
	);
});

it("keeps every other wall byte for byte the same as every other", () => {
	const cap = renderModal({ wallKey: "transcription_cap" });
	const capText = modalText();
	cap.unmount();

	renderModal({ wallKey: "upload_cap" });
	expect(modalText()).not.toBe(capText);
	expect(modalText()).not.toContain("Your free transcription hour is used up.");
});

it("carries an attempt for every wall, and none for the page that is not one", () => {
	const walls: WallKey[] = [
		"chat_cap",
		"chat_turn_cap",
		"chat_voice_cap",
		"custom_logo",
		"private_workspace",
		"report_cap",
		"transcription_cap",
		"transcripts_view",
		"upload_cap",
		"webhooks",
		"workspace_cap",
	];

	for (const wall of walls) {
		const action = wallActionLine(wall);
		expect(action.length).toBeGreaterThan(0);
		// A phrase, read inside the opening line, so it starts lowercase and
		// stops on nothing of its own.
		expect(action[0]).toBe(action[0].toLowerCase());
		expect(action.endsWith(".")).toBe(false);
	}

	// The billing page is not a wall, and neither is a mount that names none.
	expect(wallActionLine("billing_page")).toBe("");
	expect(wallActionLine(undefined)).toBe("");
});

// 3. No tier name anywhere on the gate path, and no price table.

it("names no tier in any gate copy", () => {
	const walls: WallKey[] = [
		"chat_cap",
		"chat_turn_cap",
		"chat_voice_cap",
		"custom_logo",
		"private_workspace",
		"report_cap",
		"transcription_cap",
		"transcripts_view",
		"upload_cap",
		"webhooks",
		"workspace_cap",
	];
	const tierNames = /changemaker|innovator|guardian/i;

	for (const wall of walls) {
		expect(wallPopoverLine(wall)).not.toMatch(tierNames);
	}

	const view = renderModal({ wallKey: "custom_logo" });
	expect(modalText()).not.toMatch(tierNames);
	view.unmount();

	wrap(
		<FeatureGate
			canRequestUpgrade
			currentTier="free"
			featureName="Webhooks"
			requiredTier="changemaker"
			wallKey="webhooks"
			workspaceId="workspace-1"
		>
			<div>the webhook section</div>
		</FeatureGate>,
	);
	expect(screen.getByTestId("feature-gate-card").textContent).not.toMatch(
		tierNames,
	);
	expect(screen.getByTestId("feature-gate-card").textContent).toContain(
		"Available on a paid plan",
	);
});

it("shows no price and no price table", () => {
	renderModal({ wallKey: "custom_logo" });
	const text = modalText();

	expect(text).not.toContain("€");
	expect(text).not.toMatch(/per seat|\/seat|billed annually|billed monthly/i);
});

// 4. The gate viewed event, the denominator.

it("fires gate_viewed on the modal when no popover came first, once", () => {
	const view = renderModal({ wallKey: "transcription_cap" });

	expect(gateViewedCalls()).toHaveLength(1);
	expect(gateViewedCalls()[0][1]).toMatchObject({
		can_request_upgrade: true,
		mount: "app",
		required_tier: "changemaker",
		surface: "modal",
		tier: "free",
		wall_key: "transcription_cap",
	});

	// A rerender is not a second encounter. The old event refired whenever the
	// tier query resolved.
	view.rerender(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/workspace"]}>
					<UpgradeModal
						canRequestUpgrade
						currentTier="free"
						entry="modal_direct"
						onClose={() => {}}
						opened
						requiredTier="changemaker"
						wallKey="transcription_cap"
						workspaceId="workspace-1"
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	expect(gateViewedCalls()).toHaveLength(1);
});

it("does not fire gate_viewed on the modal when the popover already did", () => {
	renderModal({ entry: "popover_link", wallKey: "custom_logo" });
	expect(gateViewedCalls()).toHaveLength(0);
});

it("fires gate_viewed from the popover, with surface popover, once", () => {
	const onStart = vi.fn();
	wrap(
		<FeatureGatePopover
			canRequestUpgrade={false}
			onStart={onStart}
			requiredTier="changemaker"
			wallKey="custom_logo"
			workspaceId="workspace-1"
		>
			{({ onClick }) => (
				<button data-testid="blocked-control" onClick={onClick} type="button">
					Custom logo
				</button>
			)}
		</FeatureGatePopover>,
	);

	fireEvent.click(screen.getByTestId("blocked-control"));
	expect(gateViewedCalls()).toHaveLength(1);
	expect(gateViewedCalls()[0][1]).toMatchObject({
		can_request_upgrade: false,
		surface: "popover",
		wall_key: "custom_logo",
	});

	// Close and open again. One encounter, one event.
	fireEvent.click(screen.getByTestId("blocked-control"));
	fireEvent.click(screen.getByTestId("blocked-control"));
	expect(gateViewedCalls()).toHaveLength(1);
});

// 5. The popover names the feature and carries the way in.

it("names the feature in the popover and starts the configurator from it", () => {
	const onStart = vi.fn();
	wrap(
		<FeatureGatePopover
			canRequestUpgrade
			onStart={onStart}
			requiredTier="changemaker"
			wallKey="webhooks"
			workspaceId="workspace-1"
		>
			{({ onClick }) => (
				<button data-testid="blocked-control" onClick={onClick} type="button">
					Webhooks
				</button>
			)}
		</FeatureGatePopover>,
	);

	fireEvent.click(screen.getByTestId("blocked-control"));
	const popover = screen.getByTestId("feature-gate-popover");
	expect(popover.textContent).toContain("Webhooks come with a paid plan.");
	expect(popover.textContent).toContain("Tell us what you need");

	// The link is a real button, so a keyboard reaches it. A tooltip could not
	// be reached at all.
	const start = screen.getByTestId("feature-gate-popover-start");
	expect(start.tagName).toBe("BUTTON");
	fireEvent.click(start);
	expect(onStart).toHaveBeenCalledTimes(1);
});

it("opens the modal directly for a wall with no agreed popover line", () => {
	const onStart = vi.fn();
	wrap(
		<FeatureGatePopover
			canRequestUpgrade
			onStart={onStart}
			requiredTier="changemaker"
			wallKey="transcription_cap"
			workspaceId="workspace-1"
		>
			{({ onClick }) => (
				<button data-testid="blocked-control" onClick={onClick} type="button">
					a locked conversation
				</button>
			)}
		</FeatureGatePopover>,
	);

	fireEvent.click(screen.getByTestId("blocked-control"));
	expect(screen.queryByTestId("feature-gate-popover")).toBeNull();
	expect(onStart).toHaveBeenCalledTimes(1);
	// The modal is the first surface here, so it owns the event, not this.
	expect(gateViewedCalls()).toHaveLength(0);
});

// 6. R5. Never sell a customer a tier they already have.

it("shows no gate to a workspace that already holds the tier", () => {
	renderModal({ currentTier: "changemaker", wallKey: "custom_logo" });

	expect(screen.queryByTestId("pricing-configurator-modal")).toBeNull();
	expect(gateViewedCalls()).toHaveLength(0);
});

it("still gates when the required tier is one nobody knows", () => {
	// `UploadLockedCard` falls back to "pioneer". An unknown tier must never
	// read as already held, or the wall closes for everybody.
	renderModal({
		requiredTier: "pioneer" as Tier,
		wallKey: "upload_cap",
	});

	expect(screen.getByTestId("pricing-configurator-modal")).toBeTruthy();
});

// 7. The keyboard reaches the card, and the card says what it is.

it("opens the gate from the keyboard on the hatched card", () => {
	wrap(
		<FeatureGate
			canRequestUpgrade
			currentTier="free"
			featureName="Webhooks"
			requiredTier="changemaker"
			wallKey="webhooks"
			workspaceId="workspace-1"
		>
			<div>the webhook section</div>
		</FeatureGate>,
	);

	const card = screen.getByTestId("feature-gate-card");
	expect(card.getAttribute("tabindex")).toBe("0");
	expect(card.getAttribute("aria-label")).toBe("Webhooks");

	fireEvent.keyDown(card, { key: "Enter" });
	expect(screen.getByTestId("feature-gate-popover")).toBeTruthy();
	expect(gateViewedCalls()).toHaveLength(1);
	expect(gateViewedCalls()[0][1]).toMatchObject({ surface: "popover" });
});

it("renders the feature itself once the tier meets", () => {
	wrap(
		<FeatureGate
			canRequestUpgrade
			currentTier="changemaker"
			featureName="Webhooks"
			requiredTier="changemaker"
			wallKey="webhooks"
			workspaceId="workspace-1"
		>
			<div data-testid="webhook-section">the webhook section</div>
		</FeatureGate>,
	);

	expect(screen.getByTestId("webhook-section")).toBeTruthy();
	expect(screen.queryByTestId("feature-gate-card")).toBeNull();
});
