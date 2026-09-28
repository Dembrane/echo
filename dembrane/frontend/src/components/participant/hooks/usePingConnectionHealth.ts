import { useCallback, useRef, useState } from "react";

/**
 * Failed pings in a row before the portal says the connection is in trouble.
 * The recording screen pings every 3 seconds, so trouble shows after about
 * 6 seconds; one lost ping on a busy network says nothing.
 */
export const FAILED_PINGS_BEFORE_TROUBLE = 2;

/**
 * The portal's connection state, read from the liveness ping it already sends.
 * Any answer from the API counts as connected; a network error, a timeout or a
 * server error counts as a failure. One answered ping clears the trouble.
 */
export function usePingConnectionHealth() {
	const failures = useRef(0);
	const [connectionHealthy, setConnectionHealthy] = useState(true);
	const reportPing = useCallback((answered: boolean) => {
		failures.current = answered ? 0 : failures.current + 1;
		setConnectionHealthy(failures.current < FAILED_PINGS_BEFORE_TROUBLE);
	}, []);
	return { connectionHealthy, reportPing };
}
