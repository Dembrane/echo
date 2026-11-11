// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSearchHits } from "./useSearchHits";

i18n.loadAndActivate({ locale: "en", messages: {} });

vi.mock("@lingui/react", () => ({
	useLingui: () => ({ i18n: { locale: "en" } }),
}));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: undefined }) }));
vi.mock("./useRecents", () => ({ useRecents: () => ({ items: [] }) }));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

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

	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
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
