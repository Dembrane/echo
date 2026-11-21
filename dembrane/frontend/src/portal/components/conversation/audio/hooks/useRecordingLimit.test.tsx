// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRecordingLimit } from "./useRecordingLimit";

type Props = {
	isRecording: boolean;
	recordingTime: number;
	limitSeconds: number | null;
};

const setup = (initial: Props) => {
	const onLimit = vi.fn();
	const view = renderHook(
		(props: Props) => useRecordingLimit({ ...props, onLimit }),
		{ initialProps: initial },
	);
	return { onLimit, rerender: view.rerender };
};

it("fires once at the limit, not a second before", () => {
	const { onLimit, rerender } = setup({
		isRecording: true,
		limitSeconds: 3600,
		recordingTime: 3599,
	});
	expect(onLimit).not.toHaveBeenCalled();
	rerender({ isRecording: true, limitSeconds: 3600, recordingTime: 3600 });
	expect(onLimit).toHaveBeenCalledTimes(1);
});

it("never fires without a limit", () => {
	const { onLimit, rerender } = setup({
		isRecording: true,
		limitSeconds: null,
		recordingTime: 3600,
	});
	rerender({ isRecording: true, limitSeconds: null, recordingTime: 99_999 });
	expect(onLimit).not.toHaveBeenCalled();
});

it("does not fire while paused", () => {
	const { onLimit } = setup({
		isRecording: false,
		limitSeconds: 3600,
		recordingTime: 3600,
	});
	expect(onLimit).not.toHaveBeenCalled();
});

it("does not fire twice as time keeps rising", () => {
	const { onLimit, rerender } = setup({
		isRecording: true,
		limitSeconds: 3600,
		recordingTime: 3600,
	});
	rerender({ isRecording: true, limitSeconds: 3600, recordingTime: 3601 });
	rerender({ isRecording: true, limitSeconds: 3600, recordingTime: 3602 });
	expect(onLimit).toHaveBeenCalledTimes(1);
});
