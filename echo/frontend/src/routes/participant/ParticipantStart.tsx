import { t } from "@lingui/core/macro";
import { Alert } from "@mantine/core";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { useParticipantProjectById } from "@/components/participant/hooks";
import ParticipantOnboardingCards from "@/components/participant/ParticipantOnboardingCards";
import { testId } from "@/lib/testUtils";

export const ParticipantStartRoute = () => {
	const { projectId } = useParams<{ projectId: string }>();

	const {
		data: project,
		isLoading: isLoadingProject,
		error: projectError,
	} = useParticipantProjectById(projectId ?? "");

	const [loadingFinished, setLoadingFinished] = useSessionStorageState(
		"loadingFinished",
		{
			defaultValue: false,
		},
	);

	const landedCaptured = useRef(false);
	useEffect(() => {
		if (!isLoadingProject) {
			setLoadingFinished(true);
			// Funnel entry, fired once per mount. Skip when embedded (the host's
			// portal-editor preview loads this in an iframe) so previews don't
			// inflate participant landings. utm_source rides along from the URL.
			if (
				!landedCaptured.current &&
				typeof window !== "undefined" &&
				window.self === window.top
			) {
				landedCaptured.current = true;
				posthog.capture("portal_landed", { project_id: projectId });
			}
		}
	}, [isLoadingProject, setLoadingFinished, projectId]);

	if (loadingFinished && projectError) {
		return (
			<div
				className="flex flex-col items-center justify-center"
				{...testId("portal-loading-error")}
			>
				<Alert color="info" {...testId("portal-error-alert")}>
					{t`An error occurred while loading the Portal. Please contact the support team.`}
				</Alert>
			</div>
		);
	}

	return (
		<div className="h-full grow">
			{isLoadingProject ? (
				<div {...testId("portal-loading-spinner")}>
					<DembraneLoadingSpinner isLoading />
				</div>
			) : (
				<ParticipantOnboardingCards project={project as ParticipantProject} />
			)}
		</div>
	);
};
