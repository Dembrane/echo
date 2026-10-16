import { useEffect, useState } from "react";

// The API sends one code per email a minute.
export const RESEND_COOLDOWN_SECONDS = 60;

/** Seconds left before another code may be sent, and a `start` to begin the wait. */
export function useResendCooldown(seconds = RESEND_COOLDOWN_SECONDS) {
	const [wait, setWait] = useState(0);

	useEffect(() => {
		if (wait <= 0) return;
		const id = setTimeout(() => setWait((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [wait]);

	return { start: () => setWait(seconds), wait };
}
