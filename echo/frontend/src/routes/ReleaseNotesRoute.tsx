import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	Container,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useSearchParams } from "react-router";
import { PilotHistory } from "@/components/release/PilotHistory";
import { RELEASES_GITHUB_URL } from "@/components/release/ReleaseMetadata";
import { ReleaseTimeline } from "@/components/release/ReleaseTimeline";
import timelineStyles from "@/components/release/ReleaseTimeline.module.css";
import { getReleases } from "@/components/release/releases";

export const ReleaseNotesRoute = () => {
	useDocumentTitle(t`Release notes | dembrane`);
	const releases = getReleases();
	const [searchParams, setSearchParams] = useSearchParams();
	const years = [
		...new Set(
			releases.flatMap((release) =>
				release.publication ? [release.publication.date.slice(0, 4)] : [],
			),
		),
	]
		.sort()
		.reverse();
	const requestedYear = searchParams.get("year");
	const year =
		requestedYear && years.includes(requestedYear) ? requestedYear : "all";
	const visibleReleases = releases.filter(
		(release) => year === "all" || release.publication?.date.startsWith(year),
	);
	const latestPublished = releases.find((release) => release.publication);
	const selectYear = (value: string) =>
		setSearchParams((previous) => {
			const next = new URLSearchParams(previous);
			if (value === "all") next.delete("year");
			else next.set("year", value);
			return next;
		});

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
				{years.length > 1 ? (
					<Group
						className={timelineStyles.intro}
						gap="xs"
						role="group"
						aria-label={t`Filter releases by year`}
					>
						<Button
							variant={year === "all" ? "filled" : "subtle"}
							aria-pressed={year === "all"}
							onClick={() => selectYear("all")}
						>
							<Trans>All years</Trans>
						</Button>
						{years.map((value) => (
							<Button
								key={value}
								variant={year === value ? "filled" : "subtle"}
								aria-pressed={year === value}
								onClick={() => selectYear(value)}
							>
								{value}
							</Button>
						))}
					</Group>
				) : null}
				{releases.length === 0 ? (
					<Text>
						<Trans>No release notes yet.</Trans>
					</Text>
				) : null}
				<ReleaseTimeline
					releases={visibleReleases}
					latestVersion={latestPublished?.version}
				/>
				{releases.length > 0 && (year === "all" || year === years.at(-1)) ? (
					<PilotHistory />
				) : null}
			</Stack>
		</Container>
	);
};
