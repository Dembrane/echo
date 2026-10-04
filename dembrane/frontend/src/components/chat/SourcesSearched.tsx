import { Trans } from "@lingui/react/macro";
import { Group, Text } from "@mantine/core";
import { CheckIcon } from "@phosphor-icons/react";

const SourcesSearched = () => {
	return (
		<Group gap="xs">
			<CheckIcon size={16} color="var(--app-success)" />
			<Text size="sm" c="dimmed">
				<Trans>Searched through the most relevant sources</Trans>
			</Text>
		</Group>
	);
};

export default SourcesSearched;
