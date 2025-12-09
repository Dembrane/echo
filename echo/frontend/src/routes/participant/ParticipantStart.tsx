import { t } from "@lingui/core/macro";
import { Alert } from "@mantine/core";
import { useEffect } from "react";
import { useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { useParticipantProjectById } from "@/components/participant/hooks";
import ParticipantOnboardingCards from "@/components/participant/ParticipantOnboardingCards";

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

	useEffect(() => {
		if (!isLoadingProject) {
			setLoadingFinished(true);
		}
	}, [isLoadingProject, setLoadingFinished]);

	if (loadingFinished && projectError) {
		return (
			<div className="flex flex-col items-center justify-center">
				<Alert color="info">
					{t`An error occurred while loading the Portal. Please contact the support team.`}
				</Alert>
			</div>
		);
	}

	return (
		<div className="h-full grow">
			{isLoadingProject ? (
				<DembraneLoadingSpinner isLoading />
			) : (
				<ParticipantOnboardingCards project={project as Project} />
			)}
		</div>
	);
};
