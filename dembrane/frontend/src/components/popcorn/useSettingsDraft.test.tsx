// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSaveContext } from "@/components/popcorn/SettingsSaveContext";
import { useSettingsDraft } from "./useSettingsDraft";

type Draft = { title: string };

type Props = { identity: string; serverValue: Draft };

const deferred = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};

const mount = (
	save: (next: Draft) => Promise<void>,
	initialProps: Props,
	wrapper?: ({ children }: { children: ReactNode }) => ReactNode,
) =>
	renderHook(
		(props: Props) =>
			useSettingsDraft<Draft>({
				flushErrorMessage: "Could not save the settings",
				identity: props.identity,
				save,
				serverValue: props.serverValue,
			}),
		{ initialProps, wrapper },
	);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("useSettingsDraft", () => {
	it("shows a change at once and saves it after the debounce", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const { result } = mount(save, {
			identity: "a",
			serverValue: { title: "server" },
		});
		expect(result.current.draft).toEqual({ title: "server" });

		act(() => result.current.changeDraft({ title: "typed" }));
		expect(result.current.draft).toEqual({ title: "typed" });
		expect(result.current.isPendingSave).toBe(true);
		expect(save).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(1_000);
		});
		expect(save).toHaveBeenCalledExactlyOnceWith({ title: "typed" });
		expect(result.current.isPendingSave).toBe(false);
	});

	it("keeps a dirty draft when a server value arrives", () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const { rerender, result } = mount(save, {
			identity: "a",
			serverValue: { title: "server" },
		});

		act(() => result.current.changeDraft({ title: "still typing" }));
		rerender({ identity: "a", serverValue: { title: "older saved value" } });

		expect(result.current.draft).toEqual({ title: "still typing" });
	});

	it("adopts a server value while the draft is clean", () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const { rerender, result } = mount(save, {
			identity: "a",
			serverValue: { title: "server" },
		});

		rerender({ identity: "a", serverValue: { title: "saved elsewhere" } });

		expect(result.current.draft).toEqual({ title: "saved elsewhere" });
		expect(save).not.toHaveBeenCalled();
	});

	it("adopts and forgets the draft when the identity changes", () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const { rerender, result } = mount(save, {
			identity: "a",
			serverValue: { title: "server" },
		});

		act(() => result.current.changeDraft({ title: "typed into the first" }));
		rerender({ identity: "b", serverValue: { title: "the other form" } });
		expect(result.current.draft).toEqual({ title: "the other form" });

		// Dirty went with the identity: the next server value is adopted.
		rerender({ identity: "b", serverValue: { title: "refetched" } });
		expect(result.current.draft).toEqual({ title: "refetched" });
	});

	it("stays dirty when a save resolves after a newer edit", async () => {
		const first = deferred();
		const save = vi.fn((next: Draft) =>
			next.title === "first" ? first.promise : Promise.resolve(),
		);
		const { rerender, result } = mount(save, {
			identity: "a",
			serverValue: { title: "server" },
		});

		act(() => result.current.changeDraft({ title: "first" }));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(save).toHaveBeenCalledExactlyOnceWith({ title: "first" });

		act(() => result.current.changeDraft({ title: "second" }));
		await act(async () => {
			first.resolve();
		});

		// The older response cleaned nothing, so the refetch is still refused.
		rerender({ identity: "a", serverValue: { title: "first" } });
		expect(result.current.draft).toEqual({ title: "second" });
	});

	it("flushes a pending draft through the shared save context", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		let flush: (() => Promise<void>) | undefined;
		const registerFlush = vi.fn((next: () => Promise<void>) => {
			flush = next;
			return () => {
				flush = undefined;
			};
		});
		const setFieldPending = vi.fn();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<SettingsSaveContext.Provider
				value={{ registerFlush, save: vi.fn(), setFieldPending }}
			>
				{children}
			</SettingsSaveContext.Provider>
		);
		const { result } = mount(
			save,
			{ identity: "a", serverValue: { title: "server" } },
			wrapper,
		);

		act(() => result.current.changeDraft({ title: "publish this" }));
		expect(setFieldPending).toHaveBeenLastCalledWith(expect.any(String), true);

		await act(async () => {
			await flush?.();
		});
		expect(save).toHaveBeenCalledExactlyOnceWith({ title: "publish this" });
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(save).toHaveBeenCalledOnce();
	});
});
