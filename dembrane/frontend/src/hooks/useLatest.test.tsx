// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { useLatest } from "./useLatest";

describe("useLatest", () => {
	it("holds the first value straight away", () => {
		const { result } = renderHook(() => useLatest("first"));
		expect(result.current.current).toBe("first");
	});

	it("is the same ref on every render, holding the latest value", () => {
		const { rerender, result } = renderHook(({ value }) => useLatest(value), {
			initialProps: { value: 1 },
		});
		const ref = result.current;
		rerender({ value: 2 });
		expect(result.current).toBe(ref);
		expect(ref.current).toBe(2);
	});

	it("is current in an effect declared after it, in the same commit", () => {
		const seen: number[] = [];
		const Probe = ({ value }: { value: number }) => {
			const latest = useLatest(value);
			useEffect(() => {
				seen.push(latest.current);
			});
			return null;
		};
		const { rerender } = render(<Probe value={1} />);
		rerender(<Probe value={2} />);
		expect(seen).toEqual([1, 2]);
	});

	it("lets a long-lived listener call the latest callback without re-subscribing", () => {
		const calls: string[] = [];
		let subscriptions = 0;
		let fire: () => void = () => {};
		const Listener = ({ onEvent }: { onEvent: () => void }) => {
			const onEventRef = useLatest(onEvent);
			useEffect(() => {
				subscriptions += 1;
				fire = () => onEventRef.current();
			}, [onEventRef]);
			return null;
		};
		const Host = () => {
			const [label, setLabel] = useState("a");
			return (
				<>
					<button type="button" onClick={() => setLabel("b")}>
						change
					</button>
					<Listener onEvent={() => calls.push(label)} />
				</>
			);
		};
		const view = render(<Host />);
		act(() => fire());
		act(() => view.getByText("change").click());
		act(() => fire());

		expect(calls).toEqual(["a", "b"]);
		expect(subscriptions).toBe(1);
	});
});
