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
		<Tooltip
			transitionProps={{ duration: 200 }}
			label={t`Show references`}
			px={5}
		>
			<ActionIcon
				variant={showCitations ? "light" : "subtle"}
				color={showCitations ? "teal" : "gray"}
				onClick={() => setShowCitations(!showCitations)}
				aria-label={t`Show references`}
				size="md"
				radius="xl"
			>
				<InfoIcon size={18} />
			</ActionIcon>
		</Tooltip>
	);
};
