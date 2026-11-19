// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { messages as dutch } from "@/locales/nl-NL";
import { type SearchWorkspace, useSearchHits } from "./useSearchHits";

i18n.load({ "en-US": {}, "nl-NL": dutch });
i18n.activate("en-US");
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: undefined }) }));
vi.mock("./useRecents", () => {
	const recents = { items: [] };
	return { useRecents: () => recents };
});

afterEach(() => {
	cleanup();
	i18n.activate("en-US");
	vi.unstubAllGlobals();
});

const client = () =>
	new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
	<I18nProvider i18n={i18n}>
		<QueryClientProvider client={client()}>{children}</QueryClientProvider>
	</I18nProvider>
);

const emptyAnswer = () =>
	new Response(
		JSON.stringify({
			chats: [],
			conversations: [],
			projects: [],
			transcripts: [],
		}),
	);

it("a search for older text is aborted when the text changes", async () => {
	const signals = new Map<string, AbortSignal>();
	const fetchMock = vi.fn((url: string, init?: RequestInit) => {
		const query = new URL(url, "http://x").searchParams.get("query") ?? "";
		signals.set(query, init?.signal as AbortSignal);
		// The first request never answers, like a server stuck on a rare phrase.
		if (query === "harb") return new Promise<Response>(() => {});
		return Promise.resolve(emptyAnswer());
	});
	vi.stubGlobal("fetch", fetchMock);

	const { rerender } = renderHook(({ q }) => useSearchHits(q, []), {
		initialProps: { q: "harb" },
		wrapper,
	});

	await waitFor(() => expect(signals.has("harb")).toBe(true));
	expect(signals.get("harb")?.aborted).toBe(false);

	rerender({ q: "harbour" });

	await waitFor(() => expect(signals.has("harbour")).toBe(true));
	expect(signals.get("harb")?.aborted).toBe(true);
	expect(signals.get("harbour")?.aborted).toBe(false);
});

it("relabels its hits in the language the person switches back to", () => {
	const workspaces: SearchWorkspace[] = [];
	const { result } = renderHook(() => useSearchHits("", workspaces), {
		wrapper,
	});
	const access = () =>
		result.current.hits.find((h) => h.href === "/settings/access")?.label;
	expect(access()).toBe("My access");

	act(() => i18n.activate("nl-NL"));
	expect(access()).toBe("Mijn toegang");

	act(() => i18n.activate("en-US"));
	expect(access()).toBe("My access");
});
