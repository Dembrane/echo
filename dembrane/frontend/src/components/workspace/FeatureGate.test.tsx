// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Tier } from "@/lib/tiers";
import { FeatureGate, UpgradeModal } from "./FeatureGate";
import { FeatureGatePopover } from "./FeatureGatePopover";
import {
	type AiAction,
	aiActionLine,
	aiBudgetHandover,
	type PlainWall,
	type SampleCap,
	type WallKey,
	wallHandoverLead,
	wallHandoverTitle,
	wallPopoverLine,
} from "./gateWalls";

const capture = vi.fn();
const saveHandover = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
	},
}));

vi.mock("@/components/pricing/submitConfiguration", () => ({
	saveHandover: (...args: unknown[]) => saveHandover(...args),
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
	saveHandover.mockReset();
	saveHandover.mockResolvedValue({ reference: "DEM-TEST" });
});

afterEach(() => {
	cleanup();
	i18n.activate("en");
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
	aiAction,
	aiUsedUp,
	currentTier = "free" as Tier,
	entry = "modal_direct" as "modal_direct" | "popover_link",
	onClose = () => {},
	requiredTier = "changemaker" as Tier,
	resetsAt,
	sampleCap,
	sampleQuestions,
	wallKey,
}: {
	aiAction?: AiAction;
	aiUsedUp?: boolean;
	currentTier?: Tier;
	entry?: "modal_direct" | "popover_link";
	onClose?: () => void;
	requiredTier?: Tier;
	resetsAt?: string | null;
	sampleCap?: SampleCap;
	sampleQuestions?: number | null;
	wallKey: WallKey;
}) =>
	wrap(
		<UpgradeModal
			aiAction={aiAction}
			aiUsedUp={aiUsedUp}
			canRequestUpgrade
			resetsAt={resetsAt}
			currentTier={currentTier}
			entry={entry}
			onClose={onClose}
			opened
			requiredTier={requiredTier}
			sampleCap={sampleCap}
			sampleQuestions={sampleQuestions}
			wallKey={wallKey}
			workspaceId="workspace-1"
		/>,
	);

const gateViewedCalls = () =>
	capture.mock.calls.filter((call) => call[0] === "pricing_config_gate_viewed");

it("names what the person ran into, for every wall, in a title of its own", () => {
	const walls: PlainWall[] = [
		"chat_voice_cap",
		"custom_logo",
		"event_cta",
		"free_allowance",
		"org_cap",
		"private_workspace",
		"project_cap",
		"recording_project",
		"transcription_cap",
		"transcripts_view",
		"upload_cap",
		"webhooks",
		"workspace_cap",
	];

	for (const wall of [...walls, "billing_page" as const]) {
		const title = wallHandoverTitle(wall);
		expect(title.length).toBeGreaterThan(0);
		// A title, not a sentence: no full stop, no em dash, no number.
		expect(title.endsWith(".")).toBe(false);
		expect(title).not.toContain("\u2014");
		expect(title).not.toMatch(/\d/);
	}
	expect(
		aiBudgetHandover({ action: "chat", resetDay: null, usedUp: true }).title,
	).toBe("This month's AI is used up");
	expect(wallHandoverTitle("webhooks")).toBe("Webhooks come with a paid plan");
	expect(wallHandoverTitle("billing_page")).toBe("Let's find what fits you");
});

it("states the free content limits without a number or an em dash", () => {
	const lines: [WallKey, string][] = [
		["project_cap", "The free plan includes a limited number of projects."],
	];
	for (const [wall, line] of lines) {
		expect(wallPopoverLine(wall)).toBe(line);
		// Staff edit these limits, so the lines state no number.
		expect(wallPopoverLine(wall)).not.toMatch(/\d|\b(one|two)\b/);
		expect(wallPopoverLine(wall)).not.toContain("\u2014");
	}
});

// The AI budget wall: one prompt for every AI action, naming the action and the reset day.

const modalText = () => screen.getByTestId("upgrade-modal").textContent ?? "";
const bodyText = () =>
	screen.getByTestId("upgrade-modal-body").textContent ?? "";

it("names the refused action and the reset day on the ai_budget wall", () => {
	renderModal({
		aiAction: "report",
		resetsAt: "2026-12-01T00:00:00Z",
		wallKey: "ai_budget",
	});

	expect(modalText()).toContain("This month's AI is used up");
	expect(bodyText()).toMatch(
		/^You were trying to create a report\. AI features and new recordings are paused until 1 December 2026\. A paid plan lets you keep going\. We'd love/,
	);
	expect(modalText()).not.toMatch(/€|euro|credit/i);
	expect(modalText()).not.toContain("\u2014");
	expect(screen.getByTestId("upgrade-modal-reassurance").textContent).toBe(
		"Everything you've made here stays as it is.",
	);
});

it("says next month when the ai_budget refusal carries no reset date", () => {
	renderModal({ aiAction: "chat", resetsAt: null, wallKey: "ai_budget" });
	expect(bodyText()).toContain(
		"You were trying to ask in chat. AI features and new recordings are paused until next month.",
	);
});

it("opens on the monthly AI allowance when used up but nothing was refused", () => {
	renderModal({
		aiUsedUp: true,
		resetsAt: "2026-12-01T00:00:00Z",
		wallKey: "ai_budget",
	});
	expect(modalText()).toContain("This month's AI is used up");
	expect(bodyText()).toMatch(
		/^You're on the free plan, which includes a monthly AI allowance\. AI features and new recordings are paused until 1 December 2026\./,
	);
	expect(bodyText()).not.toContain("You were trying to");
});

it("opens neutrally while the budget still has room, even with an action passed", () => {
	renderModal({
		aiAction: "chat",
		aiUsedUp: false,
		resetsAt: "2026-12-01T00:00:00Z",
		wallKey: "ai_budget",
	});
	expect(modalText()).toContain(
		"Your free plan includes a monthly AI allowance",
	);
	expect(bodyText()).toMatch(
		/^A paid plan gives you more AI every month\. We'd love/,
	);
	expect(modalText()).not.toContain("You were trying to");
	expect(modalText()).not.toContain("used up");
	expect(modalText()).not.toContain("paused until");
});

it.each([
	["chat", "Sample projects allow 10 questions"],
	["report", "Sample projects allow one report"],
] as const)(
	"a sample project's %s cap has its own wall: only the cap and the way on",
	(cap, title) => {
		renderModal({ sampleCap: cap, wallKey: "sample_cap" });
		expect(modalText()).toContain(title);
		expect(bodyText()).toMatch(
			/^Create your own project to keep going\. We'd love/,
		);
		expect(modalText()).not.toContain("You were trying to");
		expect(modalText()).not.toMatch(/AI allowance|AI is used up/);
		expect(gateViewedCalls()[0]?.[1]).toMatchObject({ wall_key: "sample_cap" });
		expect(new URL(continueLink().href).searchParams.get("trigger")).toBe(
			"sample_cap",
		);
	},
);

it("names the question cap the refusal carried", () => {
	renderModal({
		sampleCap: "chat",
		sampleQuestions: 12,
		wallKey: "sample_cap",
	});
	expect(modalText()).toContain("Sample projects allow 12 questions");
});

it("keeps the AI copy off every other wall", () => {
	renderModal({ wallKey: "custom_logo" });
	expect(modalText()).not.toContain("AI");
	expect(wallPopoverLine("ai_budget")).toBe("");
	expect(wallPopoverLine("sample_cap")).toBe("");
});

it("names every AI action as a lowercase phrase", () => {
	const lines: [AiAction, string][] = [
		["chat", "ask in chat"],
		["assistant", "ask the assistant"],
		["voice", "use your voice in chat"],
		["report", "create a report"],
		["map", "generate a map"],
		["analysis", "run an analysis"],
		["popcorn", "keep analysing with popcorn"],
		["canvas", "refresh the canvas"],
		["retranscribe", "retranscribe a conversation"],
	];
	for (const [action, line] of lines) {
		expect(aiActionLine(action)).toBe(line);
	}
});

// 2. The prompt is one screen, and the person chooses whether to go.

const continueLink = () =>
	screen.getByTestId("upgrade-modal-continue") as HTMLAnchorElement;

it("says what they hit and offers the website, without sending them anywhere", () => {
	const onClose = vi.fn();
	renderModal({ onClose, wallKey: "project_cap" });

	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.textContent).toContain(
		"You've reached the free plan's project limit",
	);
	const body = screen.getByTestId("upgrade-modal-body").textContent;
	expect(body).toMatch(/^A paid plan lets you keep going\. We'd love/);
	expect(body).toContain("about two minutes on our website");
	expect(screen.getByTestId("upgrade-modal-reassurance").textContent).toBe(
		"Everything you've made here stays as it is.",
	);
	expect(onClose).not.toHaveBeenCalled();
	expect(saveHandover).not.toHaveBeenCalled();
});

it("continues in a new tab with the trigger and a handover id, and saves that id for the account", () => {
	const onClose = vi.fn();
	renderModal({ onClose, wallKey: "custom_logo" });

	const link = continueLink();
	expect(link.getAttribute("target")).toBe("_blank");
	const url = new URL(link.href);
	expect(url.origin + url.pathname).toBe(
		"https://www.dembrane.com/pricing-calculator",
	);
	expect(url.searchParams.get("from")).toBe("app");
	expect(url.searchParams.get("trigger")).toBe("custom_logo");
	expect(url.searchParams.get("back")).toBe(window.location.origin);
	const handover = url.searchParams.get("handover") ?? "";
	expect(handover).toMatch(/^[0-9a-f-]{36}$/);
	// Nothing about the person travels in the address.
	expect(link.href).not.toContain("example.com");
	expect(link.href).not.toContain("workspace-1");

	fireEvent.click(link);
	expect(saveHandover).toHaveBeenCalledWith({
		config_session_id: handover,
		locale: "en",
		org_id: "org-1",
		project_id: undefined,
		wall_key: "custom_logo",
		workspace_id: "workspace-1",
	});
	expect(onClose).toHaveBeenCalledTimes(1);
	expect(
		capture.mock.calls.find(
			(c) => c[0] === "pricing_config_handover_continued",
		)?.[1],
	).toMatchObject({ config_session_id: handover, wall_key: "custom_logo" });
});

it("opens the tab with the same id it saves, though closing re-renders in the same click", () => {
	function Harness() {
		const [opened, setOpened] = useState(true);
		return (
			<UpgradeModal
				canRequestUpgrade
				currentTier="free"
				onClose={() => setOpened(false)}
				opened={opened}
				requiredTier="changemaker"
				wallKey="project_cap"
				workspaceId="workspace-1"
			/>
		);
	}
	wrap(<Harness />);
	const link = continueLink();
	let followed = "";
	// The browser follows the link after the click handlers ran: read it then.
	link.addEventListener("click", (event) => {
		event.preventDefault();
		followed = (event.currentTarget as HTMLAnchorElement).href;
	});
	fireEvent.click(link);
	const saved = saveHandover.mock.calls[0]?.[0]?.config_session_id;
	expect(saved).toBeTruthy();
	expect(new URL(followed || link.href).searchParams.get("handover")).toBe(
		saved,
	);
	expect(new URL(link.href).searchParams.get("handover")).toBe(saved);
});

it("sends Dutch speakers to the Dutch calculator", () => {
	i18n.load("nl-NL", {});
	i18n.activate("nl-NL");
	renderModal({ wallKey: "custom_logo" });

	expect(new URL(continueLink().href).pathname).toBe("/nl/pricing-calculator");
});

it("lets the person stay with Maybe later, and saves nothing", () => {
	const onClose = vi.fn();
	renderModal({ onClose, wallKey: "org_cap" });

	fireEvent.click(screen.getByTestId("upgrade-modal-later"));
	expect(onClose).toHaveBeenCalledTimes(1);
	expect(saveHandover).not.toHaveBeenCalled();
	expect(
		capture.mock.calls.some(
			(c) => c[0] === "pricing_config_handover_dismissed",
		),
	).toBe(true);
});

it("says a paid plan is needed once, in the title or in the body", () => {
	const usageWalls: PlainWall[] = [
		"chat_voice_cap",
		"free_allowance",
		"org_cap",
		"project_cap",
		"recording_project",
		"transcription_cap",
		"workspace_cap",
	];
	const featureWalls: PlainWall[] = [
		"custom_logo",
		"event_cta",
		"private_workspace",
		"transcripts_view",
		"upload_cap",
		"webhooks",
	];

	for (const wall of usageWalls) {
		expect(wallHandoverLead(wall)).toBe("A paid plan lets you keep going.");
		expect(wallHandoverTitle(wall)).not.toContain("paid plan");
	}
	for (const wall of featureWalls) {
		expect(wallHandoverLead(wall)).toBe("");
		expect(wallHandoverTitle(wall)).toContain("paid plan");
	}
	expect(wallHandoverLead("billing_page")).toBe("");

	renderModal({ wallKey: "webhooks" });
	expect(screen.getByTestId("upgrade-modal-body").textContent).toMatch(
		/^We'd love/,
	);
});

it("tells the person at the transcription cap that nothing recorded is lost", () => {
	renderModal({ wallKey: "transcription_cap" });
	expect(screen.getByTestId("upgrade-modal-reassurance").textContent).toContain(
		"nothing your participants say is lost",
	);
});

it("keeps the save from blocking the way forward", async () => {
	saveHandover.mockRejectedValue(new Error("offline"));
	const onClose = vi.fn();
	renderModal({ onClose, wallKey: "upload_cap" });
	fireEvent.click(continueLink());
	expect(onClose).toHaveBeenCalledTimes(1);
});

// 3. No tier name anywhere on the gate path.

it("names no tier in any gate copy", () => {
	const walls: WallKey[] = [
		"ai_budget",
		"chat_voice_cap",
		"custom_logo",
		"event_cta",
		"free_allowance",
		"org_cap",
		"private_workspace",
		"project_cap",
		"recording_project",
		"sample_cap",
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

it("names the refused AI action on the ai_budget wall's gate events", () => {
	renderModal({ aiAction: "report", wallKey: "ai_budget" });
	expect(gateViewedCalls()[0][1]).toMatchObject({
		ai_action: "report",
		wall_key: "ai_budget",
	});
	fireEvent.click(continueLink());
	const configEvents = capture.mock.calls.filter(
		(call) =>
			String(call[0]).startsWith("pricing_config_") &&
			call[0] !== "pricing_config_gate_viewed",
	);
	expect(configEvents.length).toBeGreaterThan(0);
	for (const call of configEvents)
		expect(call[1]).toMatchObject({ ai_action: "report" });
});

it("carries no AI action on any other wall's gate event", () => {
	renderModal({ wallKey: "custom_logo" });
	expect(gateViewedCalls()[0][1]).not.toHaveProperty("ai_action");
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

it("names the feature in the popover and starts the upgrade prompt from it", () => {
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

it("opens the prompt directly for a wall with no agreed popover line", () => {
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

	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	expect(gateViewedCalls()).toHaveLength(0);
});

it("still gates when the required tier is one nobody knows", () => {
	// `UploadLockedCard` falls back to "pioneer". An unknown tier must never
	// read as already held, or the wall closes for everybody.
	renderModal({
		requiredTier: "pioneer" as Tier,
		wallKey: "upload_cap",
	});

	expect(screen.getByTestId("upgrade-modal")).toBeTruthy();
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
