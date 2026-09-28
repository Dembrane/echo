import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Text } from "@mantine/core";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { Release } from "./releases";

export const RELEASES_GITHUB_URL = "https://github.com/dembrane/echo/releases";

export const releaseGithubUrl = (release: Release): string | undefined => {
	if (!release.publication) return undefined;
	const path = release.publication.source === "tag" ? "tree" : "releases/tag";
	return `https://github.com/dembrane/echo/${path}/${encodeURIComponent(release.publication.tag)}`;
};

export const ReleaseMetadata = ({
	release,
	latest = false,
}: {
	release: Release;
	latest?: boolean;
}) => {
	const { i18n } = useLingui();
	const publication = release.publication;
	if (!publication)
		return (
			<Text size="sm" c="primary">
				<Trans>Upcoming</Trans>
			</Text>
		);

	return (
		<Group gap="md" wrap="wrap">
			<Anchor
				href={releaseGithubUrl(release)}
				target="_blank"
				rel="noopener noreferrer"
				size="sm"
				style={{ alignItems: "center", display: "inline-flex", gap: 4 }}
			>
				{publication.tag}
				<ArrowUpRight size={16} aria-hidden />
			</Anchor>
			<Text component="time" dateTime={publication.date} size="sm">
				{new Intl.DateTimeFormat(i18n.locale, {
					day: "numeric",
					month: "long",
					timeZone: "UTC",
					year: "numeric",
				}).format(new Date(`${publication.date}T00:00:00Z`))}
			</Text>
			{latest ? (
				<Text size="sm" c="primary">
					<Trans>Latest release</Trans>
				</Text>
			) : null}
		</Group>
	);
};
