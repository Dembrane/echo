import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";

type VerifyInstructionsProps = {
	objectLabel: string;
	isLoading?: boolean;
	onNext: () => void;
	buttonText?: string;
	canProceed?: boolean;
};

const INSTRUCTIONS = [
	{
		key: "receive-artefact",
		render: (objectLabel: string) => (
			<Trans id="participant.concrete.instructions.receive.artefact">
				You'll soon get {objectLabel} to make them concrete.
			</Trans>
		),
	},
	{
		key: "read-aloud",
		render: (objectLabel: string) => (
			<Trans id="participant.concrete.instructions.read.aloud">
				Once you receive the {objectLabel}, read it aloud and share out loud
				what you want to change, if anything.
			</Trans>
		),
	},
	{
		key: "revise-artefact",
		render: (objectLabel: string) => (
			<Trans id="participant.concrete.instructions.revise.artefact">
				Once you have discussed, hit "revise" to see the {objectLabel} change to
				reflect your discussion.
			</Trans>
		),
	},
	{
		key: "approve-artefact",
		render: (objectLabel: string) => (
			<Trans id="participant.concrete.instructions.approve.artefact">
				If you are happy with the {objectLabel} click "Approve" to show you feel
				heard.
			</Trans>
		),
	},
	{
		key: "approval-helps",
		render: (_objectLabel: string) => (
			<Trans id="participant.concrete.instructions.approval.helps">
				Your approval helps us understand what you really think!
			</Trans>
		),
	},
];
export const VerifyInstructions = ({
	objectLabel,
	isLoading = false,
	onNext,
	canProceed = true,
}: VerifyInstructionsProps) => {
	return (
		<Stack gap="lg" pt="2xl" className="h-full">
			<Stack gap="2xl" className="flex-grow">
				{INSTRUCTIONS.map((instruction, index) => (
					<Group
						key={instruction.key}
						gap="md"
						align="flex-start"
						wrap="nowrap"
					>
						<Box
							className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
								!isLoading ? "bg-gray-400 text-white" : "bg-blue-500 text-white"
							}`}
						>
							<Text size="lg" fw={600}>
								{index + 1}
							</Text>
						</Box>
						<Text size="md" className="flex-1">
							{instruction.render(objectLabel)}
						</Text>
					</Group>
				))}
			</Stack>

			{/* Next button */}
			<Button
				size="lg"
				radius="3xl"
				onClick={onNext}
				className="w-full disabled:text-gray-600"
				disabled={isLoading || !canProceed}
				rightSection={
					isLoading ? (
						<Loader size="sm" color="dark" className="ml-1" />
					) : (
						<IconArrowRight size={20} className="ml-1" />
					)
				}
			>
				{isLoading ? (
					<Trans id="participant.concrete.instructions.loading">Loading</Trans>
				) : (
					<Trans id="participant.concrete.instructions.button.next">Next</Trans>
				)}
			</Button>
		</Stack>
	);
};
