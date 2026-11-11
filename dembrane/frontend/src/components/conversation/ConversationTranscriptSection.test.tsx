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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptSection } from "./ConversationTranscriptSection";

i18n.load("en-US", {});
i18n.activate("en-US");

const chunk = (n: number) => ({
	conversation_id: "c1",
	error: null,
	id: `chunk-id-${n}`,
	path: "",
	timestamp: "",
	transcript: `piece ${n}`,
});

const state = vi.hoisted(() => ({
	fetchNextPage: vi.fn(),
	hasNextPage: true,
	pages: [] as { chunks: unknown[] }[],
}));

vi.mock("./hooks", () => ({
	useConversationFinalTranscript: () => ({ data: undefined }),
	useInfiniteConversationChunks: () => ({
		data: { pages: state.pages },
		fetchNextPage: state.fetchNextPage,
		hasNextPage: state.hasNextPage,
		isFetchingNextPage: false,
		status: "success",
	}),
}));
vi.mock("./useChunkAnchorScroll", () => ({
	useChunkAnchorScroll: () => null,
}));
vi.mock("./ConversationChunkAudioTranscript", () => ({
	ConversationChunkAudioTranscript: () => <div />,
}));
vi.mock("./CopyConversationTranscript", () => ({
	CopyConversationTranscriptActionIcon: () => null,
}));
vi.mock("./DownloadConversationTranscript", () => ({
	DownloadConversationTranscriptModalActionIcon: () => null,
}));
vi.mock("./RetranscribeConversation", () => ({
	RetranscribeConversationModalActionIcon: () => null,
}));
vi.mock("./FinalTranscript", () => ({ FinalTranscript: () => null }));
vi.mock("./LockedTranscriptOverlay", () => ({
	LockedTranscriptOverlay: () => null,
}));
// Nothing is ever in view, so the button is shown.
vi.mock("react-intersection-observer", () => ({
	useInView: () => ({ inView: false, ref: () => {} }),
}));
vi.mock("use-session-storage-state", () => ({
	default: (_key: string, opts: { defaultValue: boolean }) => [
		opts.defaultValue,
		() => {},
	],
}));

const renderSection = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ConversationTranscriptSection
					conversationId="c1"
					isAnonymized={false}
					isFinished
					isLocked={false}
					participantName="Ada"
				/>
			</MantineProvider>
		</I18nProvider>,
	);

describe("ConversationTranscriptSection scroll to bottom", () => {
	const scrollIntoView = vi.fn();

	afterEach(cleanup);

	beforeEach(() => {
		scrollIntoView.mockClear();
		state.fetchNextPage.mockReset();
		state.pages = [{ chunks: [chunk(1)] }];
		Element.prototype.scrollIntoView = scrollIntoView;
		window.matchMedia ??= ((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			matches: false,
			media: query,
			removeEventListener: () => {},
			removeListener: () => {},
		})) as unknown as typeof window.matchMedia;
		window.ResizeObserver ??= class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	});

	it("loads all remaining pages, then scrolls to the end", async () => {
		state.hasNextPage = true;
		state.fetchNextPage
			.mockResolvedValueOnce({ hasNextPage: true })
			.mockResolvedValueOnce({ hasNextPage: true })
			.mockResolvedValueOnce({ hasNextPage: false });

		renderSection();
		fireEvent.click(screen.getByLabelText("Scroll to bottom"));

		await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
		expect(state.fetchNextPage).toHaveBeenCalledTimes(3);
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
	});

	it("scrolls at once when there is no next page", async () => {
		state.hasNextPage = false;

		renderSection();
		fireEvent.click(screen.getByLabelText("Scroll to bottom"));

		await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
		expect(state.fetchNextPage).not.toHaveBeenCalled();
	});

	it("ignores a second click while the pages load", async () => {
		state.hasNextPage = true;
		let finish: (v: { hasNextPage: boolean }) => void = () => {};
		state.fetchNextPage.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);

		renderSection();
		const button = screen.getByLabelText("Scroll to bottom");
		fireEvent.click(button);
		fireEvent.click(button);
		expect(state.fetchNextPage).toHaveBeenCalledTimes(1);

		finish({ hasNextPage: false });
		await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
	});
});
