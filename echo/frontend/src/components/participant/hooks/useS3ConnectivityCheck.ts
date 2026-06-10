import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import useSessionStorageState from "use-session-storage-state";
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
			posthog.capture("s3_connectivity_check_failed");
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
		posthog.capture("s3_reconnect_attempted");
		runCheck();
	};

	return { retry, s3Status };
};
