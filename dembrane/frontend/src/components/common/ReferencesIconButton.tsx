import { t } from "@lingui/core/macro";
import { ActionIcon, Tooltip } from "@mantine/core";
import { InfoIcon } from "@phosphor-icons/react";

export const ReferencesIconButton = ({
	showCitations,
	setShowCitations,
}: {
	showCitations: boolean;
	setShowCitations: (value: boolean) => void;
}) => {
	return (
		<Tooltip transitionProps={{ duration: 200 }} label={t`Show references`}>
			<ActionIcon
				variant={showCitations ? "light" : "subtle"}
				color={showCitations ? "primary" : "gray"}
				onClick={() => setShowCitations(!showCitations)}
				aria-label={t`Show references`}
			>
				<InfoIcon size={20} />
			</ActionIcon>
		</Tooltip>
	);
};
