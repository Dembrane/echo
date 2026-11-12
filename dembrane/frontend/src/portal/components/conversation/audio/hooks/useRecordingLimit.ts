import { useEffect, useRef } from "react";

/** Calls onLimit once when the recorded time (pauses excluded) reaches the limit. */
export const useRecordingLimit = ({
	isRecording,
	recordingTime,
	limitSeconds,
	onLimit,
}: {
	isRecording: boolean;
	recordingTime: number;
	limitSeconds: number | null;
	onLimit: () => void;
}): void => {
	const firedRef = useRef(false);
	const onLimitRef = useRef(onLimit);
	onLimitRef.current = onLimit;

	useEffect(() => {
		if (firedRef.current) return;
		if (!isRecording || limitSeconds === null) return;
		if (recordingTime < limitSeconds) return;
		firedRef.current = true;
		onLimitRef.current();
	}, [isRecording, recordingTime, limitSeconds]);
};
