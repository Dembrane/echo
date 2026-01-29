import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NotePencilIcon } from "@phosphor-icons/react";
import { useCallback } from "react";

import { useLocation, useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { NavigationButton } from "../common/NavigationButton";
import { CreateReportForm } from "./CreateReportForm";
import { useLatestProjectReport } from "./hooks";

export const ReportModalNavigationButton = () => {
	const [opened, { open, close }] = useDisclosure();

	const navigate = useI18nNavigate();

	const { projectId } = useParams();
	const { pathname } = useLocation();

	const { data: projectReport, isFetching: isLoadingProjectReport } =
		useLatestProjectReport(projectId ?? "");

	const handleClick = useCallback(() => {
		if (projectReport) {
			navigate(`/projects/${projectId}/report`);
		} else {
			open();
		}
	}, [projectReport, navigate, open, projectId]);

	const handleSuccess = useCallback(() => {
		close();
		navigate(`/projects/${projectId}/report`);
	}, [navigate, projectId, close]);

	return (
		<>
			<Modal
				opened={opened}
				onClose={close}
				title={
					<Text fw={500} size="lg">
						<Trans>Create Report</Trans>
					</Text>
				}
				withinPortal
				classNames={{
					header: "border-b",
				}}
			>
				<Stack>
					<CreateReportForm onSuccess={handleSuccess} />
				</Stack>
			</Modal>

			<NavigationButton
				loading={isLoadingProjectReport}
				loadingTooltip={t`Connecting to report services...`}
				onClick={handleClick}
				rightIcon={<NotePencilIcon size={24} color="var(--app-text)" />}
				active={pathname.includes("report")}
			>
				<Trans>Report</Trans>
			</NavigationButton>
		</>
	);
};
