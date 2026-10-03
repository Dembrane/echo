import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

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
			<Trans id="participant.verify.instructions.receive.artefact">
				You'll soon get {objectLabel} to verify.
			</Trans>
		),
	},
	{
		key: "read-aloud",
		render: (objectLabel: string) => (
			<Trans id="participant.verify.instructions.read.aloud">
				Once you receive the {objectLabel}, read it aloud and share out loud
				what you want to change, if anything.
			</Trans>
		),
	},
	{
		key: "revise-artefact",
		render: (objectLabel: string) => (
			<Trans id="participant.verify.instructions.revise.artefact">
				Once you have discussed, hit "revise" to see the {objectLabel} change to
				reflect your discussion.
			</Trans>
		),
	},
	{
		key: "approve-artefact",
		render: (objectLabel: string) => (
			<Trans id="participant.verify.instructions.approve.artefact">
				If you are happy with the {objectLabel} click "Approve" to show you feel
				heard.
			</Trans>
		),
	},
	{
		key: "approval-helps",
		render: (_objectLabel: string) => (
			<Trans id="participant.verify.instructions.approval.helps">
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
		<Stack
			gap="lg"
			pt="xl"
			className="h-full"
			{...testId("portal-verify-instructions-container")}
		>
			<Stack gap="lg" className="flex-grow">
				{INSTRUCTIONS.map((instruction, index) => (
					<Group
						key={instruction.key}
						gap="md"
						align="flex-start"
						wrap="nowrap"
					>
						<Box
							className={`flex h-10 w-10 flex-shrink-0 items-center justify-center ${
								isLoading
									? "bg-primary-100 text-primary-700"
									: "bg-[var(--app-rule-color)]"
							}`}
						>
							<Text size="md" c="inherit">
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
				variant="filled"
				onClick={onNext}
				className="w-full"
				loading={isLoading}
				disabled={isLoading || !canProceed}
				rightSection={<ArrowRightIcon size={20} />}
				{...testId("portal-verify-instructions-next-button")}
			>
				<Trans id="participant.verify.instructions.button.next">Continue</Trans>
			</Button>
		</Stack>
	);
};
