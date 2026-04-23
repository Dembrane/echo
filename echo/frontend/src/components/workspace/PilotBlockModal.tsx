import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text, Title } from "@mantine/core";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { usePilotBlockSignal } from "@/lib/pilotBlock";

/**
 * Level-3 status modal for the Pilot hard-block (matrix §8).
 *
 * Fired via emitPilotBlock() when a mutation 402s with the copy-locked
 * body. Copy lifts verbatim from matrix §8 — the participant-reassurance
 * line is non-negotiable.
 *
 * Escape hatches: "Go to usage" (opens the billing tab) and "Request
 * upgrade" (jumps straight to the tier compare view). Never "Dismiss"
 * alone — a hard block shouldn't be clearable just by clicking away.
 */
export const PilotBlockModal = () => {
	const { detail, clear } = usePilotBlockSignal();
	const { workspaceId } = useWorkspace();
	const navigate = useI18nNavigate();

	const open = detail !== null;
	const targetId = detail?.workspaceId || workspaceId;

	return (
		<Modal
			opened={open}
			onClose={clear}
			withCloseButton={false}
			centered
			size="md"
			overlayProps={{ opacity: 0.5, blur: 2 }}
		>
			<Stack gap={16}>
				<Title order={4} fw={400}>
					<Trans>Pilot limit reached</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						You've used all 10 hours of the pilot. Host-side tools
						(chat, reports, analysis, exports) are paused.
					</Trans>
				</Text>
				<Text size="sm">
					<Trans>
						Recording keeps working — your participants are unaffected.
					</Trans>
				</Text>
				<Group gap={12} mt={8} justify="flex-end">
					<Button
						size="sm"
						onClick={() => {
							clear();
							if (targetId) {
								navigate(`/w/${targetId}/settings/billing`);
							}
						}}
					>
						<Trans>Go to billing</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
