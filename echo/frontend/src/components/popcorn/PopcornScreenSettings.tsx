import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Paper, Stack, Switch, Text, Title } from "@mantine/core";
import {
	type PopcornDetail,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import { TIER_ORDER, type Tier } from "@/lib/tiers";

function meetsTier(tier: string | null | undefined, minimum: Tier): boolean {
	const index = TIER_ORDER.indexOf((tier ?? "free") as Tier);
	return index >= 0 && index >= TIER_ORDER.indexOf(minimum);
}

// What the room sees, switch by switch. Each one lands on the wall at its
// next poll; nothing here needs a Save.
export function PopcornScreenSettings({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const { workspace } = useWorkspace();
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const busy = settings.isPending;
	const canRemoveMark = meetsTier(workspace?.tier, "changemaker");
	const tabs = popcorn.settings.tabs;

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-screen")}
		>
			<Stack gap="md">
				<Title order={4}>
					<Trans>Screen</Trans>
				</Title>
				<Switch
					size={FIELD_SIZE}
					label={t`Tensions tab`}
					description={t`The pulls between what people want, verified against the conversations.`}
					checked={tabs.tensions}
					disabled={busy}
					onChange={(event) =>
						settings.mutate({ tabs: { tensions: event.currentTarget.checked } })
					}
					{...testId("popcorn-tab-tensions")}
				/>
				<Switch
					size={FIELD_SIZE}
					label={t`Stakeholders tab`}
					description={t`Who holds a stake, and how they relate.`}
					checked={tabs.stakeholders}
					disabled={busy}
					onChange={(event) =>
						settings.mutate({
							tabs: { stakeholders: event.currentTarget.checked },
						})
					}
					{...testId("popcorn-tab-stakeholders")}
				/>
				<Switch
					size={FIELD_SIZE}
					label={t`QR code`}
					description={t`The link to add a voice, in the corner of the stage.`}
					checked={popcorn.settings.show_qr}
					disabled={busy}
					onChange={(event) =>
						settings.mutate({ show_qr: event.currentTarget.checked })
					}
					{...testId("popcorn-qr-toggle")}
				/>
				<Switch
					size={FIELD_SIZE}
					label={t`Names on the legend`}
					description={t`Off numbers the conversations. On shows the name typed on the phone, which may be a person's.`}
					checked={popcorn.settings.public_labels === "names"}
					disabled={busy}
					onChange={(event) =>
						settings.mutate({
							public_labels: event.currentTarget.checked ? "names" : "neutral",
						})
					}
					{...testId("popcorn-labels-toggle")}
				/>
				{canRemoveMark ? (
					<Switch
						size={FIELD_SIZE}
						label={t`Show "made with dembrane" on the screen`}
						description={t`Your plan lets you take the mark off.`}
						checked={popcorn.settings.show_branding ?? true}
						disabled={busy}
						onChange={(event) =>
							settings.mutate({ show_branding: event.currentTarget.checked })
						}
						{...testId("popcorn-branding-toggle")}
					/>
				) : (
					<Group
						gap="xs"
						align="center"
						wrap="wrap"
						{...testId("popcorn-branding-note")}
					>
						<Text size="sm">
							<Trans>"made with dembrane" stays on the screen.</Trans>
						</Text>
						<Badge size="sm" variant="outline">
							<Trans>Changemaker plan takes it off</Trans>
						</Badge>
					</Group>
				)}
			</Stack>
		</Paper>
	);
}
