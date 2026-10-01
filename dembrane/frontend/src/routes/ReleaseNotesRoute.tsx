import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Container, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { PilotHistory } from "@/components/release/PilotHistory";
import { RELEASES_GITHUB_URL } from "@/components/release/ReleaseMetadata";
import { ReleaseTimeline } from "@/components/release/ReleaseTimeline";
import timelineStyles from "@/components/release/ReleaseTimeline.module.css";
import { getReleases } from "@/components/release/releases";

export const ReleaseNotesRoute = () => {
	useDocumentTitle(t`Release notes | dembrane`);
	const releases = getReleases();
	const latestPublished = releases.find((release) => release.publication);

	return (
		<Container size="lg" px={{ base: "md", sm: "xl" }} py="xl">
			<Stack gap="xl">
				<Stack gap="sm" className={timelineStyles.intro}>
					<Title order={1}>
						<Trans>Release notes</Trans>
					</Title>
					<Text>
						<Trans>New features, improvements and fixes in dembrane.</Trans>
					</Text>
					<Anchor
						href={RELEASES_GITHUB_URL}
						target="_blank"
						rel="noopener noreferrer"
						size="sm"
					>
						<Trans>All releases on GitHub</Trans>
					</Anchor>
				</Stack>
				{releases.length === 0 ? (
					<Text>
						<Trans>No release notes yet.</Trans>
					</Text>
				) : null}
				<ReleaseTimeline
					releases={releases}
					latestVersion={latestPublished?.version}
				/>
				{releases.length > 0 ? <PilotHistory /> : null}
			</Stack>
		</Container>
	);
};
