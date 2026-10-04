import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Paper, Stack, Title } from "@mantine/core";
import type { ReactNode } from "react";
import {
	type PopcornDetail,
	popcornEmbedSnippet,
	popcornPublicUrl,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { QRMenu, ShareControls } from "@/components/sharing/Share";
import { testId } from "@/lib/testUtils";

// Share, as on every outcome: the Public page switch, then the code.
export function PopcornShare({
	projectId,
	popcorn,
	embedded = false,
	presentation = false,
	extras,
}: {
	projectId: string;
	popcorn: PopcornDetail;
	embedded?: boolean;
	presentation?: boolean;
	/** Menu items this outcome adds under the code's shortcuts. */
	extras?: ReactNode;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const token = popcorn.public_token;
	const publicUrl = token
		? presentation
			? new URL(
					`/present/public/${encodeURIComponent(token)}`,
					window.location.origin,
				).toString()
			: popcornPublicUrl(token)
		: null;
	const embed = token
		? presentation && publicUrl
			? `<iframe src="${publicUrl}" title="Presentation" width="100%" height="720" style="border:0" allowfullscreen></iframe>`
			: popcornEmbedSnippet(token)
		: undefined;

	const controls = (
		<ShareControls
			isPublic={popcorn.settings.public}
			onPublicChange={(value) => settings.mutate({ public: value })}
			pending={settings.isPending}
			description={t`Anyone with the link can watch. No login, and no transcripts.`}
			qr={
				publicUrl && (
					<QRMenu
						links={{ url: publicUrl }}
						embed={embed}
						fileName={popcorn.name || "presentation"}
						extras={extras}
					/>
				)
			}
		/>
	);
	if (embedded) return controls;
	return (
		<Paper withBorder p="lg" {...testId("popcorn-share")}>
			<Stack gap="md">
				<Title order={4}>
					<Trans>Share</Trans>
				</Title>
				{controls}
			</Stack>
		</Paper>
	);
}
