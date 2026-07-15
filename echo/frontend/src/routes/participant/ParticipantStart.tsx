import { t } from "@lingui/core/macro";
import { Alert } from "@mantine/core";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { useParticipantProjectById } from "@/components/participant/hooks";
import ParticipantOnboardingCards from "@/components/participant/ParticipantOnboardingCards";
import { ENABLE_MONITOR } from "@/config";
import { useVisitorBeacon } from "@/hooks/useVisitorBeacon";
import { testId } from "@/lib/testUtils";

type FunnelStageReport = {
	stage: string;
	tags: string[];
	tagsPreselected: boolean;
};

export const ParticipantStartRoute = () => {
	const { projectId } = useParams<{ projectId: string }>();

	// One visitor beacon for the whole portal onboarding, owned here so it
	// fires "scanned" the moment the QR link opens — before the project even
	// loads and before the onboarding deck mounts. The deck reports its finer
	// stage (terms / mic / profile) up via onFunnelStage.
	const [funnel, setFunnel] = useState<FunnelStageReport>({
		stage: "scanned",
		tags: [],
		tagsPreselected: false,
	});
	useVisitorBeacon(projectId, {
		enabled: ENABLE_MONITOR,
		stage: funnel.stage,
		tags: funnel.tags,
		tagsPreselected: funnel.tagsPreselected,
	});

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
				<ParticipantOnboardingCards
					project={project as ParticipantProject}
					onFunnelStage={setFunnel}
				/>
			)}
		</div>
	);
};
