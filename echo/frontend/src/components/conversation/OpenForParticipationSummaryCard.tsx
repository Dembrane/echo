import { t } from "@lingui/core/macro";
import { Switch, Tooltip } from "@mantine/core";
import {
	useProjectById,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import { Icons } from "@/icons";
import { testId } from "@/lib/testUtils";
import { SummaryCard } from "../common/SummaryCard";

interface OpenForParticipationSummaryCardProps {
	projectId: string;
}

export const OpenForParticipationSummaryCard = ({
	projectId,
}: OpenForParticipationSummaryCardProps) => {
	const projectQuery = useProjectById({
		projectId,
		query: {
			fields: ["id", "is_conversation_allowed"],
		},
	});
	const updateProjectMutation = useUpdateProjectByIdMutation();

	const handleOpenForParticipationCheckboxChange = (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		updateProjectMutation.mutate({
			id: projectId,
			payload: {
				is_conversation_allowed: e.target.checked,
			},
		});
	};

	return (
		<SummaryCard
			loading={projectQuery.isLoading}
			icon={<Icons.Phone width="24px" />}
			label={t`Open for Participation?`}
			value={
				<Tooltip
					position="bottom"
					label={t`Allow participants using the link to start new conversations`}
				>
					<Switch
						size="md"
						checked={projectQuery.data?.is_conversation_allowed}
						disabled={updateProjectMutation.isPending}
						onChange={handleOpenForParticipationCheckboxChange}
						{...testId("dashboard-open-for-participation-toggle")}
					/>
				</Tooltip>
			}
			{...testId("dashboard-open-for-participation-card")}
		/>
	);
};
