import { Trans } from "@lingui/react/macro";
import { Box, Progress, Text } from "@mantine/core";

type SourcesSearchProps = {
	progressValue: number;
};

const SourcesSearch = ({ progressValue }: SourcesSearchProps) => {
	return (
		<Box className="rounded-bl-0 w-fit rounded-br-[0.75rem] rounded-tl-[0.75rem] rounded-tr-[0.75rem] border border-green-500 px-4 py-3">
			<Text size="sm" className="mb-2 text-center">
				<Trans>Searching through the most relevant sources</Trans>
			</Text>
			<Progress value={progressValue} color="green" size="sm" />
		</Box>
	);
};

export default SourcesSearch;
