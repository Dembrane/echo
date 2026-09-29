// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { apiNoAuth } from "@/lib/api";
import { useConversationChunkContentUrl } from "./index";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const originalAdapter = apiNoAuth.defaults.adapter;
afterEach(() => {
	apiNoAuth.defaults.adapter = originalAdapter;
});

describe("useConversationChunkContentUrl", () => {
	// Locally the axios baseURL is the relative /api, which axios prefixes onto
	// any path, including one that already starts with it.
	it("requests the chunk content under a single /api prefix", async () => {
		const requested: string[] = [];
		apiNoAuth.defaults.adapter = async (config) => {
			requested.push(apiNoAuth.getUri(config));
			return {
				config,
				data: "https://storage.example/chunk.mp3",
				headers: {},
				status: 200,
				statusText: "OK",
			};
		};

		const { result } = renderHook(
			() => useConversationChunkContentUrl("conv-1", "chunk-1"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(requested).toEqual([
			"/api/conversations/conv-1/chunks/chunk-1/content?return_url=true",
		]);
		expect(result.current.data).toBe("https://storage.example/chunk.mp3");
	});
});
