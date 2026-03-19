import { useCallback, useEffect, useRef, useState } from "react";
import useSessionStorageState from "use-session-storage-state";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { checkS3Connectivity } from "@/lib/api";

type S3Status = "pending" | "checking" | "passed" | "failed";

export const useS3ConnectivityCheck = (
	conversationId: string | undefined,
	opts: { queriesLoading: boolean },
) => {
	const [s3CheckPassed, setS3CheckPassed] = useSessionStorageState(
		`s3-check-${conversationId}`,
		{ defaultValue: false },
	);

	const [s3Status, setS3Status] = useState<S3Status>(() =>
		s3CheckPassed ? "passed" : "pending",
	);

	const checkStarted = useRef(false);

	const runCheck = useCallback(async () => {
		setS3Status("checking");
		const reachable = await checkS3Connectivity(conversationId ?? "");
		if (reachable) {
			setS3CheckPassed(true);
		} else {
			try {
				analytics.trackEvent(events.S3_CONNECTIVITY_CHECK_FAILED);
			} catch (_error) {
				console.warn("Analytics tracking failed:", _error);
			}
		}
		setS3Status(reachable ? "passed" : "failed");
	}, [conversationId, setS3CheckPassed]);

	useEffect(() => {
		if (
			conversationId &&
			!opts.queriesLoading &&
			!checkStarted.current &&
			!s3CheckPassed
		) {
			checkStarted.current = true;
			runCheck();
		}
	}, [conversationId, opts.queriesLoading, s3CheckPassed, runCheck]);

	const retry = () => {
		try {
			analytics.trackEvent(events.S3_CONNECTIVITY_RECONNECT_ATTEMPT);
		} catch (_error) {
			console.warn("Analytics tracking failed:", _error);
		}
		runCheck();
	};

	return { retry, s3Status };
};
