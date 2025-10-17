import { Trans } from "@lingui/react/macro";
import { Box, Group, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";

const SourcesSearched = () => {
	return (
		<Box className="rounded-bl-0 w-fit rounded-br-[0.75rem] rounded-tl-[0.75rem] rounded-tr-[0.75rem] border border-green-500 px-4 py-3">
			<Group>
				<Box className="rounded-full bg-green-500 p-1">
					<IconCheck size={16} color="white" />
				</Box>
				<Text size="sm">
					<Trans>Searched through the most relevant sources</Trans>
				</Text>
			</Group>
		</Box>
	);
};

export default SourcesSearched;
