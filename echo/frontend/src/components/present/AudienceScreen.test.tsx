// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AudienceScreen } from "./AudienceScreen";
import {
	AUDIENCE_EVENT_REFRESH_MS,
	AUDIENCE_RETRY_MIN_MS,
	AUDIENCE_SAFETY_REFRESH_MS,
} from "./audienceContract";

const { useServerEventsMock } = vi.hoisted(() => ({
	useServerEventsMock: vi.fn(),
}));
vi.mock("@/hooks/useServerEvents", () => ({
	useServerEvents: useServerEventsMock,
}));
vi.mock("@/components/common/QRCode", () => ({
	QRCode: ({ value }: { value: string }) => (
		<div data-testid="rendered-qr">{value}</div>
	),
}));
vi.mock("./AudienceMapAdapter", () => ({
	AudienceMapAdapter: () => <div data-testid="audience-map" />,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
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
});

afterEach(() => {
	cleanup();
	useServerEventsMock.mockReset();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const renderAudience = (props: {
	embedded?: boolean;
	presentationId?: string;
	publicToken?: string;
}) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<AudienceScreen {...props} />
			</MantineProvider>
		</I18nProvider>,
	);

const response = (
	blocks: Array<"popcorn" | "tensions" | "map" | "stakeholders">,
) => ({
	bundle: {
		files: {
			"popcorn/result.json": {},
			"session.json": { ui_language: "en" },
		},
	},
	id: "presentation-1",
	manifest: { blocks, opening: blocks[0] ?? null, version: 1 },
});

describe("AudienceScreen lifecycle", () => {
	it("keeps opening screens available with no selected result tabs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response([]),
					bundle: {
						files: {
							"session.json": {
								data: { title: "Data" },
								intro: { enabled: true },
								ui_language: "en",
							},
						},
					},
				}),
				ok: true,
			}),
		);
		renderAudience({ presentationId: "presentation-1" });
		expect(
			await screen.findByRole("button", { name: "Introduction" }),
		).toBeTruthy();
		expect(screen.getByTitle("Presentation")).toBeTruthy();
	});

	it("keeps one outer frame around opening, map, notice, QR and status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response(["map"]),
					bundle: {
						files: {
							"popcorn/one.json": { done: true },
							"session.json": {
								branding: true,
								intro: { enabled: true },
								language: "en",
								notice: { text: "This is a synthetic example." },
								qr: {
									url: "https://portal.example/join",
								},
								title: "Shared frame",
								transcripts: [{ id: "one" }, { id: "two" }],
							},
						},
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		const footer = await screen.findByTestId("audience-frame-footer");
		const iframe = screen.getByTitle("Presentation") as HTMLIFrameElement;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						live: true,
						madeWith: "made with dembrane",
						presentationId: "presentation-1",
						progress: "reading 1 of 2 conversations…",
						qrFold: "fold the QR code away",
						qrLabel: "add your voice",
						qrShow: "show the QR code",
						source: "dembrane-present-deck",
						type: "chrome",
						version: 1,
					},
					origin: new URL(iframe.src).origin,
					source: iframe.contentWindow,
				}),
			);
		});
		expect(screen.getByTestId("audience-notice").textContent).toContain(
			"This is a synthetic example.",
		);
		expect(screen.getByTestId("rendered-qr").textContent).toBe(
			"https://portal.example/join",
		);
		expect(screen.getByTestId("audience-qr").textContent).toContain(
			"add your voice",
		);
		expect(footer.textContent).toContain("reading 1 of 2 conversations…");
		expect(footer.textContent).toContain("made with dembrane");
		fireEvent.click(
			screen.getByRole("button", { name: "fold the QR code away" }),
		);
		expect(screen.queryByTestId("rendered-qr")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "show the QR code" }));
		expect(screen.getByTestId("rendered-qr")).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "Map" }));
		expect(screen.getByTestId("audience-frame-footer")).toBe(footer);
		expect(screen.getByTestId("audience-qr")).toBeTruthy();
	});

	it("keeps the presentation frame when no activities or openings are selected", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response([]),
					bundle: {
						files: {
							"session.json": { title: "Empty presentation" },
						},
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		expect(await screen.findByText("Empty presentation")).toBeTruthy();
		expect(screen.getByTestId("audience-frame-footer")).toBeTruthy();
		expect(
			screen.getByText("No activities are selected for this presentation."),
		).toBeTruthy();
	});

	it("starts with a foldable QR chip in the embedded editor preview", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response(["popcorn"]),
					bundle: {
						files: {
							"session.json": {
								qr: { url: "https://portal.example/join" },
								title: "Preview",
							},
						},
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ embedded: true, presentationId: "presentation-1" });
		expect(await screen.findByRole("button", { name: "QR" })).toBeTruthy();
		expect(screen.queryByTestId("rendered-qr")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "QR" }));
		expect(screen.getByTestId("rendered-qr")).toBeTruthy();
	});

	it("shows ordered underlined activity tabs above the stage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response(["map"]),
					manifest: {
						blocks: ["stakeholders", "map", "popcorn", "tensions"],
						opening: "map",
						version: 1,
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		const tabs = await screen.findAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Popcorn",
			"Tensions",
			"Map",
			"Stakeholders",
		]);
		expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
		const panel = screen.getByRole("tabpanel");
		expect(tabs[2]?.getAttribute("aria-controls")).toBe(panel.id);
		expect(panel.getAttribute("aria-labelledby")).toBe(tabs[2]?.id);
		expect(
			tabs[0]?.compareDocumentPosition(screen.getByTitle("Presentation")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("shows the presentation identity and formats its date in the project language", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response(["tensions"]),
					bundle: {
						files: {
							"session.json": {
								client: "Gemeente Utrecht",
								date: "18 September 2026",
								date_iso: "2026-09-18",
								language: "nl",
								title: "Samen stad maken",
							},
						},
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });

		expect(await screen.findByText("Samen stad maken")).toBeTruthy();
		expect(
			screen.getByText("Gemeente Utrecht · 18 september 2026"),
		).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Spanningen" })).toBeTruthy();
	});

	it("keeps a map opening visible and lets the audience revisit opening screens", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					...response(["map"]),
					bundle: {
						files: {
							"session.json": {
								data: { title: "Data policy" },
								intro: { enabled: true },
								ui_language: "en",
							},
						},
					},
				}),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		const iframe = (await screen.findByTitle(
			"Presentation",
		)) as HTMLIFrameElement;
		await waitFor(() =>
			expect(iframe.classList.contains("invisible")).toBe(false),
		);
		expect(
			screen
				.getByRole("button", { name: "Data policy" })
				.getAttribute("data-active"),
		).toBeNull();
		expect(
			screen
				.queryByTestId("audience-map")
				?.parentElement?.className.includes("hidden"),
		).toBe(true);

		const postMessage = vi.spyOn(iframe.contentWindow as Window, "postMessage");
		fireEvent.click(screen.getByRole("button", { name: "Data policy" }));
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ command: "opening", screen: "data" }),
			new URL(iframe.src).origin,
		);

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						open: false,
						presentationId: "presentation-1",
						source: "dembrane-present-deck",
						type: "opening",
						version: 1,
					},
					origin: new URL(iframe.src).origin,
					source: iframe.contentWindow,
				}),
			);
		});
		expect(iframe.className.includes("invisible")).toBe(true);
		expect(
			screen
				.queryByTestId("audience-map")
				?.parentElement?.className.includes("hidden"),
		).toBe(false);
	});

	it("clears public content when the stream drops and the link was switched off", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => response(["map"]),
				ok: true,
				status: 200,
			})
			.mockResolvedValueOnce({
				json: async () => ({}),
				ok: false,
				status: 404,
			});
		vi.stubGlobal("fetch", fetchMock);

		renderAudience({ publicToken: "revoked-token" });
		expect(await screen.findByTestId("audience-map")).toBeTruthy();
		expect(useServerEventsMock.mock.calls.at(-1)?.[1]).toContain(
			"disconnected",
		);

		// The server ends a revoked stream; the hook reports the drop.
		const onEvent = useServerEventsMock.mock.calls.at(-1)?.[2];
		act(() => onEvent({ type: "disconnected" }));

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(
			screen.getByText("This presentation is not available."),
		).toBeTruthy();
		expect(screen.queryByTestId("audience-map")).toBeNull();
		expect(screen.queryByTitle("Presentation")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toContain(
			"/v2/popcorn/public/revoked-token/audience",
		);
		// No reconnect loop against a link that is switched off.
		expect(useServerEventsMock.mock.calls.at(-1)?.[0]).toBeNull();
	});

	it("keeps the room's screen through a failed read and tries again", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => response(["map"]),
				ok: true,
				status: 200,
			})
			.mockResolvedValueOnce({
				json: async () => ({}),
				ok: false,
				status: 502,
			})
			.mockResolvedValueOnce({
				json: async () => response(["map"]),
				ok: true,
				status: 200,
			});
		vi.stubGlobal("fetch", fetchMock);

		renderAudience({ publicToken: "public-token" });
		expect(await screen.findByTestId("audience-map")).toBeTruthy();

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const onEvent = useServerEventsMock.mock.calls.at(-1)?.[2];
		await act(async () => {
			onEvent({ type: "disconnected" });
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByTestId("audience-map")).toBeTruthy();

		await act(async () => {
			vi.advanceTimersByTime(AUDIENCE_RETRY_MIN_MS);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(screen.getByTestId("audience-map")).toBeTruthy();
	});

	it("reads on the safety interval only, with no faster poll for public links", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => response(["map"]),
			ok: true,
			status: 200,
		});
		vi.stubGlobal("fetch", fetchMock);

		renderAudience({ publicToken: "public-token" });
		expect(await screen.findByTestId("audience-map")).toBeTruthy();
		const reads = fetchMock.mock.calls.length;

		act(() => vi.advanceTimersByTime(AUDIENCE_SAFETY_REFRESH_MS - 1));
		expect(fetchMock).toHaveBeenCalledTimes(reads);
	});

	it("disables the result tabs while the deck holds a locked opening", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => response(["popcorn", "tensions"]),
				ok: true,
				status: 200,
			}),
		);
		renderAudience({ presentationId: "presentation-1" });
		const iframe = (await screen.findByTitle(
			"Presentation",
		)) as HTMLIFrameElement;
		const opening = (open: boolean, locked: boolean) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							locked,
							open,
							presentationId: "presentation-1",
							...(open ? { screen: "intro" } : {}),
							source: "dembrane-present-deck",
							type: "opening",
							version: 1,
						},
						origin: new URL(iframe.src).origin,
						source: iframe.contentWindow,
					}),
				);
			});

		// A synthetic demo: its disclosure cannot be skipped from the tabs.
		opening(true, true);
		const tensions = screen.getByRole("tab", { name: "Tensions" });
		expect(tensions.hasAttribute("disabled")).toBe(true);

		// The deck's own Continue flow finished.
		opening(false, false);
		expect(
			screen.getByRole("tab", { name: "Tensions" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("resends the current block after a verified deck ready event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => response(["popcorn"]),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		const iframe = (await screen.findByTitle(
			"Presentation",
		)) as HTMLIFrameElement;
		const postMessage = vi.spyOn(iframe.contentWindow as Window, "postMessage");
		postMessage.mockClear();
		const origin = new URL(iframe.src).origin;

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						presentationId: "presentation-1",
						revision: 2,
						source: "dembrane-present-deck",
						type: "ready",
						version: 1,
					},
					origin,
					source: iframe.contentWindow,
				}),
			);
		});

		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				block: "popcorn",
				command: "block",
				presentationId: "presentation-1",
			}),
			origin,
		);
	});

	it("coalesces connected and update events into a cache-safe projection refresh", async () => {
		const initial = response(["popcorn"]);
		const updated = {
			...response(["tensions"]),
			bundle: {
				files: {
					"session.json": { language: "nl", title: "Bijgewerkt" },
					"tensions.json": {},
				},
			},
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => initial,
				ok: true,
				status: 200,
			})
			.mockResolvedValueOnce({
				json: async () => updated,
				ok: true,
				status: 200,
			});
		vi.stubGlobal("fetch", fetchMock);

		renderAudience({ presentationId: "presentation-1" });
		const iframe = (await screen.findByTitle(
			"Presentation",
		)) as HTMLIFrameElement;
		const postMessage = vi.spyOn(iframe.contentWindow as Window, "postMessage");
		const origin = new URL(iframe.src).origin;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						presentationId: "presentation-1",
						revision: 1,
						source: "dembrane-present-deck",
						type: "ready",
						version: 1,
					},
					origin,
					source: iframe.contentWindow,
				}),
			);
		});
		postMessage.mockClear();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const onEvent = useServerEventsMock.mock.calls.at(-1)?.[2];

		act(() => {
			onEvent({ type: "connected" });
			onEvent({ type: "update" });
		});
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ command: "refresh" }),
			origin,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(AUDIENCE_EVENT_REFRESH_MS);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Bijgewerkt")).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Spanningen" })).toBeTruthy();
	});

	it("delivers an event refresh once when the deck becomes ready", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => response(["popcorn"]),
				ok: true,
				status: 200,
			}),
		);

		renderAudience({ presentationId: "presentation-1" });
		const iframe = (await screen.findByTitle(
			"Presentation",
		)) as HTMLIFrameElement;
		const postMessage = vi.spyOn(iframe.contentWindow as Window, "postMessage");
		postMessage.mockClear();
		const onEvent = useServerEventsMock.mock.calls.at(-1)?.[2];
		act(() => onEvent({ type: "connected" }));
		expect(postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ command: "refresh" }),
			expect.any(String),
		);

		const origin = new URL(iframe.src).origin;
		const ready = () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						presentationId: "presentation-1",
						revision: 1,
						source: "dembrane-present-deck",
						type: "ready",
						version: 1,
					},
					origin,
					source: iframe.contentWindow,
				}),
			);
		act(ready);
		expect(postMessage).toHaveBeenCalledTimes(3);
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ command: "refresh" }),
			origin,
		);

		postMessage.mockClear();
		act(ready);
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ command: "refresh" }),
			expect.any(String),
		);
	});
});
