import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { popcornSampleViewUrl } from "@/components/popcorn/hooks";
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";

// The first meeting with popcorn, for a project that has not opted in yet.
// Says what it is, when to use it, and turns the beta on in one step.
export function PopcornIntroModal({
	opened,
	projectId,
	onClose,
}: {
	opened: boolean;
	projectId: string;
	onClose: () => void;
}) {
	const updateProject = useUpdateProjectByIdMutation();
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Popcorn`}
			size="xl"
			{...testId("popcorn-intro-modal")}
		>
			<Stack gap="md">
				<Box
					className="overflow-hidden rounded-md border"
					style={{ borderColor: "var(--mantine-color-gray-3)", height: 460 }}
				>
					<iframe
						title={t`Sample popcorn session`}
						src={popcornSampleViewUrl(0.75)}
						className="block h-full w-full border-0"
						{...testId("popcorn-intro-sample-frame")}
					/>
				</Box>
				<Text size="xs">
					<Trans>
						A sample session, not your data. Yours will look like this.
					</Trans>
				</Text>
				<Text>
					<Trans>
						Popcorn shows a room its own words while it is still talking: live
						slides from this project's conversations, for a big screen. It is
						early, and you can turn it off again in the project settings.
					</Trans>
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Not now</Trans>
					</Button>
					<Button
						loading={updateProject.isPending}
						onClick={() =>
							updateProject.mutate({
								id: projectId,
								payload: { is_canvas_enabled: true },
							})
						}
						{...testId("popcorn-intro-enable")}
					>
						<Trans>Turn on popcorn</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
