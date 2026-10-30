// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ConversationMessages } from "./ConversationMessages";

let online = true;

vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => online }));
vi.mock("@/portal/components/conversation/queries", () => ({
	combineUserChunks: (chunks: unknown[]) => chunks[0],
	useConversationChunksQuery: () => ({ data: [] }),
	useConversationRepliesQuery: () => ({ data: [] }),
}));
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({ data: undefined }),
}));
vi.mock("@formkit/auto-animate/react", () => ({
	useAutoAnimate: () => [() => {}],
}));

const SERVER_TROUBLE =
	"We're having trouble reaching our server, but keep going: your audio is saved on this device and will send once we reconnect.";
const KEEP_GOING =
	"You seem to be offline, but keep going: your audio is saved on this device and will send once you're back online.";
const OFFLINE_TEXT =
	"You seem to be offline, please check your internet connection";

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
});

beforeEach(() => {
	online = true;
});

afterEach(cleanup);

const renderMessages = (
	props: Partial<Parameters<typeof ConversationMessages>[0]> = {},
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ConversationMessages projectId="p1" conversationId="c1" {...props} />
			</MantineProvider>
		</I18nProvider>,
	);

describe("connection banner", () => {
	it("shows nothing while connected", () => {
		renderMessages();
		expect(screen.queryByText(KEEP_GOING)).toBeNull();
		expect(screen.queryByText(SERVER_TROUBLE)).toBeNull();
		expect(screen.queryByText(/refresh/i)).toBeNull();
	});

	it("tells an offline participant to keep going, and never to refresh", () => {
		online = false;
		// Pings fail offline too; being offline is the whole story.
		renderMessages({ connectionHealthy: false });
		expect(screen.getByText(KEEP_GOING)).toBeTruthy();
		expect(screen.queryByText(SERVER_TROUBLE)).toBeNull();
		expect(screen.queryByText(/refresh/i)).toBeNull();
	});

	it("blames the server when it stops answering while online", () => {
		renderMessages({ connectionHealthy: false });
		expect(screen.getByText(SERVER_TROUBLE)).toBeTruthy();
		expect(screen.queryByText(KEEP_GOING)).toBeNull();
		expect(screen.queryByText(/refresh/i)).toBeNull();
	});

	it("keeps the plain offline warning in text mode, where nothing is saved", () => {
		online = false;
		renderMessages({ mode: "text" });
		expect(screen.getByText(OFFLINE_TEXT)).toBeTruthy();
		expect(screen.queryByText(KEEP_GOING)).toBeNull();
	});
});
