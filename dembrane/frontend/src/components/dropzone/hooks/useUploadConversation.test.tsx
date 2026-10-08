// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useUploadConversation } from "./index";

vi.mock("@/lib/api", () => ({
	initiateAndUploadConversationChunk: vi.fn(async () => ({})),
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { success: vi.fn() },
}));

it("an upload refreshes the conversation counts on the organisation overview", async () => {
	const qc = new QueryClient();
	const keys = [
		["v2", "workspaces"],
		["v2", "workspace-usage", "w1", 0],
		["v2", "org-usage", "o1", 0],
	];
	for (const k of keys) qc.setQueryData(k, {});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useUploadConversation(), { wrapper });
	await act(() =>
		result.current.mutateAsync({
			chunks: [],
			namePrefix: "",
			pin: "",
			projectId: "p1",
			tagIdList: [],
			timestamps: [],
		}),
	);
	for (const k of keys) expect(qc.getQueryState(k)?.isInvalidated).toBe(true);
});
