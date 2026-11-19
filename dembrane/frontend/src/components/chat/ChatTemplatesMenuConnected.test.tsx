// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { menu, mutation, refetch, suggestions, suggestionsEnabled, state } =
	vi.hoisted(() => {
		const refetch = vi.fn();
		return {
			menu: { props: {} as Record<string, unknown> },
			mutation: () => ({
				isPending: false,
				mutate: vi.fn(),
				mutateAsync: vi.fn(),
			}),
			refetch,
			state: {
				conversations: [] as unknown[],
				hideAiSuggestions: false,
				quickAccess: [] as { id: string; type: "static" | "user" }[],
				userTemplates: [] as { id: string; title: string }[],
			},
			suggestions: { data: { suggestions: [{ id: "s1" }] }, refetch },
			suggestionsEnabled: [] as boolean[],
		};
	});

vi.mock("./ChatTemplatesMenu", () => ({
	ChatTemplatesMenu: (props: Record<string, unknown>) => {
		menu.props = props;
		return null;
	},
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en" }),
}));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({
		data: { hide_ai_suggestions: state.hideAiSuggestions },
	}),
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: { id: "p1", workspace_id: "w1" } }),
}));
vi.mock("./hooks", () => ({
	useChatSuggestions: (_chatId: string, opts: { enabled: boolean }) => {
		suggestionsEnabled.push(opts.enabled);
		return suggestions;
	},
	useProjectChatContext: () => ({
		data: { conversations: state.conversations },
	}),
}));
vi.mock("./hooks/useUserTemplates", () => ({
	useCreateUserTemplate: mutation,
	useDeleteUserTemplate: mutation,
	useQuickAccessPreferences: () => ({ data: state.quickAccess }),
	useSaveQuickAccessPreferences: mutation,
	useToggleAiSuggestions: mutation,
	useUpdateUserTemplate: mutation,
	useUserTemplates: () => ({ data: state.userTemplates }),
}));

// Template titles resolve on import, so the locale has to exist first.
i18n.loadAndActivate({ locale: "en-US", messages: {} });
const { ChatTemplatesMenuConnected } = await import(
	"./ChatTemplatesMenuConnected"
);
const { Templates } = await import("./templates");

type Props = Partial<ComponentProps<typeof ChatTemplatesMenuConnected>>;
const client = new QueryClient();
const ui = (props: Props) => (
	<QueryClientProvider client={client}>
		<I18nProvider i18n={i18n}>
			<ChatTemplatesMenuConnected
				chatId="c1"
				projectId="p1"
				onTemplateSelect={() => {}}
				{...props}
			/>
		</I18nProvider>
	</QueryClientProvider>
);

beforeEach(() => {
	vi.clearAllMocks();
	suggestionsEnabled.length = 0;
	Object.assign(state, {
		conversations: [],
		hideAiSuggestions: false,
		quickAccess: [],
		userTemplates: [],
	});
});
afterEach(cleanup);

const quickAccessIds = () =>
	(menu.props.quickAccessItems as { id: string }[]).map((i) => i.id);

describe("ChatTemplatesMenuConnected", () => {
	it("offers the first three templates until quick access is set", () => {
		render(ui({ chatMode: "overview" }));
		expect(quickAccessIds()).toEqual(Templates.slice(0, 3).map((t) => t.id));
	});

	it("keeps the saved quick access, user templates included, dropping ones that are gone", () => {
		state.quickAccess = [
			{ id: "mine", type: "user" },
			{ id: Templates[Templates.length - 1].id, type: "static" },
			{ id: "deleted", type: "user" },
		];
		state.userTemplates = [{ id: "mine", title: "Mine" }];
		render(ui({ chatMode: "overview" }));
		expect(quickAccessIds()).toEqual([
			"mine",
			Templates[Templates.length - 1].id,
		]);
	});

	it("fetches suggestions in overview, and in deep dive only once conversations are added", () => {
		const { rerender } = render(ui({ chatMode: "overview" }));
		expect(suggestionsEnabled.at(-1)).toBe(true);
		rerender(ui({ chatMode: "deep_dive" }));
		expect(suggestionsEnabled.at(-1)).toBe(false);
		expect(refetch).not.toHaveBeenCalled();

		state.conversations = [{ id: "a" }];
		rerender(ui({ chatMode: "deep_dive" }));
		expect(suggestionsEnabled.at(-1)).toBe(true);
		expect(refetch).toHaveBeenCalledTimes(1);

		rerender(ui({ chatMode: "deep_dive" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("never fetches suggestions in agentic mode or when they are hidden", () => {
		render(ui({ chatMode: "agentic" }));
		expect(suggestionsEnabled.every((e) => e === false)).toBe(true);
		cleanup();
		state.hideAiSuggestions = true;
		render(ui({ chatMode: "overview" }));
		expect(suggestionsEnabled.at(-1)).toBe(false);
		expect(menu.props.suggestions).toEqual([]);
	});

	it("refetches once each time the refetch key changes, not on mount", () => {
		const { rerender } = render(
			ui({ chatMode: "overview", refetchSuggestionsKey: 1 }),
		);
		expect(refetch).not.toHaveBeenCalled();
		rerender(ui({ chatMode: "overview", refetchSuggestionsKey: 1 }));
		expect(refetch).not.toHaveBeenCalled();
		rerender(ui({ chatMode: "overview", refetchSuggestionsKey: 2 }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});
});
