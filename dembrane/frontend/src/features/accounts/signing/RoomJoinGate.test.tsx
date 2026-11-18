// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The page the room invitation email links to (/o/:orgId/account/join?invite=<token>):
// who invited them to which organisation, the one-time code sign-in SignGate already has,
// then accept and land in the room. SignGate.tsx exports RoomJoinGate, built on the same
// invitation flow as the signer's page (no second one).
const state = vi.hoisted(() => ({
	accepted: false,
	/** The status accepting answers with instead of accepting (403, 404, 409). */
	acceptRefused: null as null | number,
	me: null as null | { email: string },
	signedIn: false,
	status: "open" as "open" | "accepted" | "closed" | "gone",
}));
const auth = vi.hoisted(() => ({
	hasSession: vi.fn(),
	sendSignInCode: vi.fn(),
	signInWithCode: vi.fn(),
}));
const calls = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
	AuthError: class extends Error {},
	hasSession: auth.hasSession,
	otherSessions: async () => ({ devices: [], held: false }),
	replaceOtherDevice: async () => {},
	requestPasswordReset: async () => {},
	resendVerificationEmail: async () => {},
	resetPassword: async () => {},
	sendSignInCode: auth.sendSignInCode,
	signIn: async () => {},
	signInWithCode: auth.signInWithCode,
	signOut: async () => {},
	verifyEmail: async () => {},
}));
vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: state.me ?? undefined }),
}));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("./SignRoute", () => ({
	SignRoute: () => <div data-testid="sign-route" />,
}));
vi.mock("../api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/client")>();
	return {
		...actual,
		call: async (name: string, options: unknown) => {
			calls(name, options);
			if (name === "roomInvite") {
				if (state.status === "gone")
					throw new actual.AccountsApiError(404, "Not found");
				return {
					has_account: false,
					inviter: { name: "Robin Example" },
					labels: ["go_ahead"],
					organisation: { name: "Example Town Council (sample)" },
					other: null,
					person: {
						email: "noor@example-town.example",
						first_name: "Noor",
						last_name: "Example",
					},
					status: state.accepted ? "accepted" : state.status,
				};
			}
			if (name === "acceptRoomInvite") {
				if (state.acceptRefused)
					throw new actual.AccountsApiError(
						state.acceptRefused,
						"Refused",
						{},
						{
							action: "none",
							code: "invite.not_found",
							detail: "Refused",
							params: {},
						},
					);
				state.accepted = true;
				return { org_id: "0199a1b5-0000-7000-8000-000000000001" };
			}
			throw new Error(`unexpected call ${name}`);
		},
	};
});

const load = async () => {
	const { RoomJoinGate } = await import("./SignGate");
	expect(RoomJoinGate, "SignGate exports RoomJoinGate").toBeTypeOf("function");
	return RoomJoinGate;
};

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
	Object.assign(state, {
		accepted: false,
		acceptRefused: null,
		me: null,
		signedIn: false,
		status: "open",
	});
	auth.hasSession.mockImplementation(async () => state.signedIn);
	auth.sendSignInCode.mockResolvedValue(undefined);
	auth.signInWithCode.mockImplementation(async () => {
		state.signedIn = true;
		state.me = { email: "noor@example-town.example" };
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const ORG = "0199a1b5-0000-7000-8000-000000000001";
const open = async (client = new QueryClient()) => {
	const RoomJoinGate = await load();
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[`/o/${ORG}/account/join?invite=tok`]}>
						<Routes>
							<Route
								path="/o/:organisationId/account/join"
								element={<RoomJoinGate />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

const accepts = () =>
	calls.mock.calls.filter(([name]) => name === "acceptRoomInvite");
const landed = () =>
	navigate.mock.calls.some(([to]) => to === `/o/${ORG}/overview`);

describe("the room invitation page, signed out", () => {
	it("says who invited them to which organisation, and asks for no signature", async () => {
		await open();
		const banner = await screen.findByTestId("invite-banner");
		expect(banner.textContent).toContain("Robin Example");
		expect(banner.textContent).toContain("Example Town Council (sample)");
		expect(
			(screen.getByTestId("invite-first-name") as HTMLInputElement).value,
		).toBe("Noor");
		expect(document.body.textContent ?? "").not.toMatch(/sign electronically/);
		expect(calls).toHaveBeenCalledWith(
			"roomInvite",
			expect.objectContaining({
				params: { orgId: ORG },
				query: { invite: "tok" },
			}),
		);
	});

	it("signs in with the emailed code, accepts once and lands in the room", async () => {
		await open();
		fireEvent.click(await screen.findByTestId("invite-send-code"));
		expect(auth.sendSignInCode).toHaveBeenCalledWith(
			"noor@example-town.example",
		);
		const digits = Array.from(
			(await screen.findByTestId("invite-code"))
				.closest("div")
				?.querySelectorAll("input") ?? [],
		).filter((i) => i.type !== "hidden");
		await act(async () => {
			digits.forEach((input, i) => {
				fireEvent.change(input, { target: { value: String(i + 1) } });
			});
		});
		const go = screen.queryByTestId("invite-open");
		if (go && !go.hasAttribute("disabled"))
			await act(async () => {
				fireEvent.click(go);
			});
		await waitFor(() => expect(landed()).toBe(true));
		expect(accepts()).toHaveLength(1);
		expect(accepts()[0]?.[1]).toMatchObject({
			body: { first_name: "Noor", invite: "tok", last_name: "Example" },
			params: { orgId: ORG },
		});
	});

	it("says an accepted invitation is accepted, and offers to log in", async () => {
		state.status = "accepted";
		await open();
		expect(await screen.findByTestId("invite-accepted")).toBeTruthy();
		expect(screen.queryByTestId("invite-send-code")).toBeNull();
	});

	it("says a closed invitation is closed", async () => {
		state.status = "closed";
		await open();
		expect(await screen.findByTestId("invite-closed")).toBeTruthy();
		expect(screen.queryByTestId("invite-send-code")).toBeNull();
	});

	it("says a withdrawn link no longer works", async () => {
		state.status = "gone";
		await open();
		expect(await screen.findByTestId("invite-gone")).toBeTruthy();
	});
});

describe("the room invitation page, signed in", () => {
	it("accepts an open invitation for this address once and lands in the room", async () => {
		state.signedIn = true;
		state.me = { email: "noor@example-town.example" };
		await open();
		await waitFor(() => expect(landed()).toBe(true));
		expect(accepts()).toHaveLength(1);
	});

	it("reads everything afresh before landing, so the room shows at once", async () => {
		state.signedIn = true;
		state.me = { email: "noor@example-town.example" };
		const client = new QueryClient();
		const order: string[] = [];
		const reset = client.resetQueries.bind(client);
		vi.spyOn(client, "resetQueries").mockImplementation(async (...args) => {
			order.push("reset");
			await reset(...(args as Parameters<typeof reset>));
		});
		navigate.mockImplementation(() => order.push("navigate"));
		await open(client);
		await waitFor(() => expect(landed()).toBe(true));
		expect(order.slice(0, 2)).toEqual(["reset", "navigate"]);
	});

	for (const status of [403, 404, 409])
		it(`says so when accepting is refused (${status}), instead of waiting forever`, async () => {
			state.signedIn = true;
			state.me = { email: "noor@example-town.example" };
			state.acceptRefused = status;
			await open();
			const failed = await screen.findByTestId("invite-failed");
			expect(failed.querySelector("[data-error-code]")).toBeTruthy();
			expect(landed()).toBe(false);
			expect(accepts()).toHaveLength(1);
		});

	it("goes straight to the room once it is accepted", async () => {
		state.signedIn = true;
		state.me = { email: "noor@example-town.example" };
		state.status = "accepted";
		await open();
		await waitFor(() => expect(landed()).toBe(true));
		expect(accepts()).toHaveLength(0);
	});

	it("stops someone signed in under another address before anything is accepted", async () => {
		state.signedIn = true;
		state.me = { email: "robin@example-town.example" };
		await open();
		expect(await screen.findByTestId("invite-not-you")).toBeTruthy();
		expect(accepts()).toHaveLength(0);
	});
});
