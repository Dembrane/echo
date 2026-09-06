import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { format } from "date-fns";
import {
	type PopcornDetail,
	type PopcornVersion,
	popcornPresenterUrl,
	usePopcornVersions,
} from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";

function versionLabel(version: PopcornVersion): string {
	const date = new Date(version.created_at);
	if (Number.isNaN(date.getTime())) return t`Version`;
	return format(date, "EEE d MMM, HH:mm");
}

function firstClause(detail: string | null | undefined): string {
	const text = (detail ?? "").split(";")[0]?.trim() ?? "";
	return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

// Every run that changed the deck is kept. Each opens the presenter view of
// that run in its own tab, phrases popping in as they did. A rerun keeps them.
export function PopcornHistory({ popcorn }: { popcorn: PopcornDetail }) {
	const versionsQuery = usePopcornVersions(popcorn.id);
	const versions = versionsQuery.data ?? [];
	if (versions.length === 0) return null;
	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-history")}
		>
			<Stack gap="md">
				<Stack gap={2}>
					<Title order={4}>
						<Trans>Earlier runs</Trans>
					</Title>
					<Text size="sm">
						<Trans>Saved in the history. A rerun keeps these.</Trans>
					</Text>
				</Stack>
				<Stack gap="xs">
					{versions.slice(0, 12).map((version) => (
						<Group
							key={version.id}
							justify="space-between"
							align="center"
							gap="sm"
							wrap="nowrap"
						>
							<Stack gap={0} className="min-w-0">
								<Text size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>
									{versionLabel(version)}
								</Text>
								<Text size="xs" truncate>
									{firstClause(version.detail)}
								</Text>
							</Stack>
							<Anchor
								href={popcornPresenterUrl(popcorn.id, version.id)}
								target="_blank"
								rel="noopener noreferrer"
								size="sm"
								className="whitespace-nowrap"
								{...testId(`popcorn-version-${version.id}`)}
							>
								<Group gap={4} wrap="nowrap">
									<Trans>Open</Trans>
									<ArrowSquareOutIcon size={14} />
								</Group>
							</Anchor>
						</Group>
					))}
				</Stack>
			</Stack>
		</Paper>
	);
}
