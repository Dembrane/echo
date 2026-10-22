import { Trans } from "@lingui/react/macro";
import { Button, type ButtonProps, Group } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { PlusIcon } from "@phosphor-icons/react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { wallPopoverLine } from "@/components/workspace/gateWalls";
import { UnavailableInfo } from "@/components/workspace/UnavailableInfo";
import { useProjectCap } from "@/hooks/useProjectCap";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isAdminRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";

// At the free project cap the button looks unavailable and opens the wall where it is.
export function CreateProjectButton({
	onCreate,
	...buttonProps
}: ButtonProps & { onCreate: () => void }) {
	const { workspace } = useWorkspace();
	const atCap = useProjectCap(workspace);
	const [wallOpened, wall] = useDisclosure(false);
	return (
		<>
			<Group gap={4} wrap="nowrap">
				<Button
					variant="filled"
					leftSection={<PlusIcon size={20} />}
					{...buttonProps}
					opacity={atCap ? 0.8 : 1}
					onClick={atCap ? wall.open : onCreate}
					{...testId("project-home-create-button")}
				>
					<Trans>Create project</Trans>
				</Button>
				{atCap && <UnavailableInfo label={wallPopoverLine("project_cap")} />}
			</Group>
			<UpgradeModal
				opened={wallOpened}
				onClose={wall.close}
				currentTier="free"
				requiredTier="changemaker"
				canRequestUpgrade={isAdminRole(workspace?.role)}
				workspaceId={workspace?.id ?? ""}
				wallKey="project_cap"
			/>
		</>
	);
}
