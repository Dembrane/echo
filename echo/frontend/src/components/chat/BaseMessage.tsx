import { t } from "@lingui/core/macro";
import {
	Box,
	Group,
	LoadingOverlay,
	Paper,
	type PaperProps,
	Stack,
	Text,
} from "@mantine/core";
import type React from "react";
import type { PropsWithChildren } from "react";

export const BaseMessage = (
	props: PropsWithChildren<{
		text?: string;
		title?: React.ReactNode;
		rightSection?: React.ReactNode;
		bottomSection?: React.ReactNode;
		paperProps?: PaperProps;
		loading?: boolean;
	}>,
) => {
	return (
		<Paper
			pos="relative"
			bg="gray.1"
			p="sm"
			className="!bg-opacity-50"
			{...props.paperProps}
		>
			<Stack>
				<Group align="start" wrap="nowrap">
					{/* <div className="pt-1">
            <Icons.Diamond color="black" />
          </div> */}
					<Box flex={1}>
						<Group align="center" justify="space-between">
							<Text mb="xs" size="sm">
								{props.title ?? t`You`}
							</Text>
							{props.rightSection}
						</Group>
						<div>
							<LoadingOverlay visible={props.loading} />
							{props.text && <Text size="sm">{props.text}</Text>}
							{props.children}
						</div>
					</Box>
				</Group>
				{props.bottomSection}
			</Stack>
		</Paper>
	);
};
