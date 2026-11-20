// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ParticipantShareModal } from "./ParticipantShareModal";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
// The QR code draws on a canvas, which jsdom lacks; its value is what matters.
vi.mock("@/components/common/QRCode", () => ({
	QRCode: ({ value }: { value: string }) => (
		<div data-testid="qr-value">{value}</div>
	),
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(navigator, "share");
});

const project = (overrides: Partial<Project> = {}) =>
	({
		id: "p1",
		is_conversation_allowed: true,
		language: "en",
		...overrides,
	}) as Project;

// Moves the participant to another URL while the modal stays mounted.
function GoTo({ to }: { to: string }) {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate(to)}>
			go
		</button>
	);
}

const show = (at: string, p: Project = project(), next = at) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[at]}>
					<GoTo to={next} />
					<ParticipantShareModal opened onClose={() => {}} project={p} />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const qrLink = () => new URL(screen.getByTestId("qr-value").textContent ?? "");

describe("ParticipantShareModal", () => {
	it("shares a fresh start link that keeps the portal setup, not the participant's details", () => {
		show("/en-US/p1/conversation/c1?mode=text&theme=dark&name=Ann");
		const link = qrLink();
		expect(link.pathname).toBe("/en-US/p1/start");
		expect(link.searchParams.get("utm_source")).toBe("portal");
		expect(link.searchParams.get("mode")).toBe("text");
		expect(link.searchParams.get("theme")).toBe("dark");
		expect(link.searchParams.get("name")).toBeNull();
		const whatsapp = screen
			.getByTestId("portal-share-whatsapp-button")
			.getAttribute("href");
		expect(whatsapp).toContain(encodeURIComponent(link.toString()));
	});

	it("follows the URL when it changes with the modal open", async () => {
		show("/en-US/p1/start?mode=text", project(), "/en-US/p1/start?mode=audio");
		expect(qrLink().searchParams.get("mode")).toBe("text");
		fireEvent.click(screen.getByRole("button", { name: "go" }));
		await waitFor(() =>
			expect(qrLink().searchParams.get("mode")).toBe("audio"),
		);
	});

	it("says the portal is closed instead of offering a link", () => {
		show("/en-US/p1/start", project({ is_conversation_allowed: false }));
		expect(
			screen.getByText("This portal is not accepting new sessions right now."),
		).toBeTruthy();
		expect(screen.queryByTestId("qr-value")).toBeNull();
	});

	it("opens the device's share menu with the link when there is one", async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "share", {
			configurable: true,
			value: share,
		});
		show("/en-US/p1/start?mode=text");
		fireEvent.click(screen.getByTestId("portal-share-native-button"));
		await waitFor(() =>
			expect(share).toHaveBeenCalledWith(
				expect.objectContaining({ url: qrLink().toString() }),
			),
		);
	});
});
