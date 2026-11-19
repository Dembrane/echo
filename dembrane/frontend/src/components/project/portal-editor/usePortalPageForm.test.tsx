// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { VerificationTopicsResponse } from "@/lib/api";
import type { SectionKey } from "./portalForm";
import { usePortalPageForm } from "./usePortalPageForm";

// The Verify page's topics follow the server: they arrive after the page's
// form is made, and later changes come in, unless the host changed them here.
const state = vi.hoisted(() => ({
	mutateAsync: vi.fn(async (_vars: unknown) => ({})),
}));
vi.mock("../hooks", () => ({
	useUpdateProjectByIdMutation: () => ({ mutateAsync: state.mutateAsync }),
}));

const project = {
	id: "p1",
	is_verify_enabled: true,
	updated_at: "2026-11-01T10:00:00.000Z",
} as unknown as Project;
const topics = (...selected: string[]) =>
	({ selected_topics: selected }) as unknown as VerificationTopicsResponse;

type Props = {
	section: SectionKey;
	verificationTopics?: VerificationTopicsResponse;
	isVerificationTopicsLoading?: boolean;
};
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		{children}
	</QueryClientProvider>
);
const usePage = (initialProps: Props) =>
	renderHook(
		(props: Props) => usePortalPageForm({ project, readOnly: false, ...props }),
		{ initialProps, wrapper },
	);
const shown = (result: { current: ReturnType<typeof usePortalPageForm> }) =>
	result.current.form.getValues("verification_topics");

it("takes the topics once they load, and later changes to them, without saving", async () => {
	state.mutateAsync.mockClear();
	const { result, rerender } = usePage({
		isVerificationTopicsLoading: true,
		section: "verify",
	});
	expect(shown(result)).toEqual([]);
	rerender({ section: "verify", verificationTopics: topics("b", "a") });
	await waitFor(() => expect(shown(result)).toEqual(["a", "b"]));
	expect(result.current.form.formState.isDirty).toBe(false);
	rerender({ section: "verify", verificationTopics: topics("a", "b", "c") });
	await waitFor(() => expect(shown(result)).toEqual(["a", "b", "c"]));
	// Only the host's own edits save; following the server doesn't.
	await new Promise((resolve) => setTimeout(resolve, 1300));
	expect(state.mutateAsync).not.toHaveBeenCalled();
});

it("keeps topics the host changed here", async () => {
	const { result, rerender } = usePage({
		section: "verify",
		verificationTopics: topics("a"),
	});
	await waitFor(() => expect(shown(result)).toEqual(["a"]));
	act(() =>
		result.current.form.setValue("verification_topics", ["a", "mine"], {
			shouldDirty: true,
		}),
	);
	rerender({ section: "verify", verificationTopics: topics("a", "theirs") });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(shown(result)).toEqual(["a", "mine"]);
});

it("keeps saved topics through the refetch that follows the save", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { result, rerender } = usePage({
		section: "verify",
		verificationTopics: topics("a"),
	});
	await waitFor(() => expect(shown(result)).toEqual(["a"]));
	act(() => {
		result.current.form.setValue("verification_topics", ["a", "b"], {
			shouldDirty: true,
		});
		result.current.saveNow(result.current.form.getValues());
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	expect(state.mutateAsync).toHaveBeenCalledWith({
		id: "p1",
		payload: expect.objectContaining({ selected_verification_key_list: "a,b" }),
	});
	// The topics query hasn't caught up yet: the form keeps what was saved.
	rerender({ section: "verify", verificationTopics: topics("a") });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	expect(shown(result)).toEqual(["a", "b"]);
	rerender({ section: "verify", verificationTopics: topics("a", "b") });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	expect(shown(result)).toEqual(["a", "b"]);
	vi.useRealTimers();
});
