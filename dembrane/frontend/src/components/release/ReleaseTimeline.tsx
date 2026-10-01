import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Group, Stack, Text } from "@mantine/core";
import { Sparkle } from "@phosphor-icons/react";
import { ReleaseChanges } from "./ReleaseChanges";
import { ReleaseDescription } from "./ReleaseDescription";
import { ReleaseMetadata } from "./ReleaseMetadata";
import styles from "./ReleaseTimeline.module.css";
import videoStyles from "./ReleaseVideoModal.module.css";
import type { Release } from "./releases";
import { youtubeEmbedUrl } from "./releaseVideo";

/** Use the public tag, never the opaque key used to remember a dismissal. */
export const isPatchRelease = (release: Release): boolean => {
	const patch = release.publication?.tag.match(/^v?\d+\.\d+\.(\d+)$/)?.[1];
	return patch !== undefined && Number(patch) > 0;
};

export const ReleaseTimeline = ({
	releases,
	latestVersion,
}: {
	releases: Release[];
	latestVersion?: string;
}) => {
	const { i18n } = useLingui();
	// The active locale doubles as the caption preference on the embeds.
	const months = new Map<string, Release[]>();
	for (const release of releases) {
		const month = release.publication?.date.slice(0, 7) ?? "upcoming";
		const entries = months.get(month) ?? [];
		entries.push(release);
		months.set(month, entries);
	}

	return (
		<div className={styles.timeline}>
			{Array.from(months, ([month, entries]) => {
				const date =
					month === "upcoming" ? null : new Date(`${month}-01T00:00:00Z`);
				const label = date
					? new Intl.DateTimeFormat(i18n.locale, {
							month: "long",
							timeZone: "UTC",
							year: "numeric",
						}).format(date)
					: t`Next`;
				const headingId = `release-month-${month}`;
				return (
					<section
						key={month}
						className={styles.monthGroup}
						aria-labelledby={headingId}
					>
						<div>
							<h2 id={headingId} aria-label={label} className={styles.month}>
								<span>
									{date
										? new Intl.DateTimeFormat(i18n.locale, {
												month: "short",
												timeZone: "UTC",
											}).format(date)
										: label}
								</span>
								{date ? (
									<span className={styles.year}>{month.slice(0, 4)}</span>
								) : null}
							</h2>
						</div>
						<div className={styles.entries}>
							{entries.map((release) => {
								const compact = isPatchRelease(release) && !release.highlight;
								const embedUrl = youtubeEmbedUrl(
									release.videoUrl ?? "",
									i18n.locale,
								);
								return (
									<article
										key={release.version}
										className={styles.entry}
										data-layout={
											release.highlight
												? "highlight"
												: compact
													? "patch"
													: "standard"
										}
									>
										<Stack gap={compact ? "xs" : "md"}>
											<Group justify="space-between" gap="sm">
												<ReleaseMetadata
													release={release}
													latest={release.version === latestVersion}
												/>
												{release.highlight ? (
													<span className={styles.highlightBadge}>
														<Sparkle size={16} aria-hidden />
														<Trans>Highlight</Trans>
													</span>
												) : null}
											</Group>
											<h3 className={styles.title}>{release.title}</h3>
											{release.description ? (
												<ReleaseDescription
													description={release.description}
													compact={compact}
												/>
											) : null}
											{release.changes?.length ? (
												<ReleaseChanges
													changes={release.changes}
													compact={compact}
												/>
											) : null}
											{embedUrl ? (
												<div className={videoStyles.videoFrame}>
													<iframe
														allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share"
														allowFullScreen
														className={videoStyles.video}
														loading="lazy"
														src={embedUrl}
														title={t`Release video: ${release.title}`}
													/>
												</div>
											) : null}
											{release.note ? (
												<Text size={compact ? "sm" : "md"}>{release.note}</Text>
											) : null}
										</Stack>
									</article>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);
};
