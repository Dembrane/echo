import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Modal, Stack } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticated } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL, CHANGELOG_DOCS_URL } from "@/config";
import { usePrefersReducedMotion } from "@/features/sidebar/animations/motion";
import { useV2Me } from "@/hooks/useV2Me";
import styles from "./ReleaseVideoModal.module.css";
import {
	latestRelease,
	RELEASE_VIDEO_SEEN_KEY,
	shouldShowReleaseVideo,
	youtubeEmbedUrl,
} from "./releaseVideo";

/**
 * The release video modal: one video, one title, one description, shown once
 * per release.
 *
 * It renders RELEASES[0] and nothing else. Earlier releases are reachable from
 * the changelog on docs.dembrane.com rather than by scrolling here, so the
 * modal stays a single thing to look at and then dismiss.
 *
 * Mounted in BaseLayout as a sibling of the Toaster, inside the layout's
 * TransitionCurtainProvider. It refuses to paint while that curtain is active,
 * which covers the in-app transitions (theme change, sign out) that run in this
 * provider. Note that the LOGIN curtain belongs to a different provider
 * instance inside AuthLayout, and AuthLayout unmounts on the post-login
 * navigate, so there is no overlap to guard against there.
 *
 * Dismissing is the whole interaction: click the backdrop, press escape, or hit
 * the close button, and the newest version is written to app_user.settings.
 * Seen means dismissed, not watched, so no YouTube Player API is loaded.
 *
 * Typography is held to exactly two combinations, both defined in the adjacent
 * stylesheet. Nothing here sets a font size, weight, colour or style.
 */
export const ReleaseVideoModal = () => {
	const { isAuthenticated } = useAuthenticated();
	const { isActive: curtainIsActive } = useTransitionCurtain();
	const { data: me, isSuccess } = useV2Me({ enabled: isAuthenticated });
	const queryClient = useQueryClient();
	const prefersReducedMotion = usePrefersReducedMotion();
	const titleId = useId();

	// Closes the modal immediately, without waiting on the network. If the write
	// fails the modal returns on the next load, which is the recoverable
	// direction: better a second showing than a dismissal that will not stick.
	const [dismissed, setDismissed] = useState(false);

	const release = latestRelease();

	const markSeen = useMutation({
		mutationFn: async (version: string) => {
			// A FLAT top-level key. PATCH /v2/me merges settings one level deep
			// server-side, so this lands beside its siblings and cannot replace
			// them. A nested object here would clobber whatever shared its parent.
			const response = await fetch(`${API_BASE_URL}/v2/me`, {
				body: JSON.stringify({
					settings: { [RELEASE_VIDEO_SEEN_KEY]: version },
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!response.ok) throw new Error("Failed to record release as seen");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
		},
	});

	const opened =
		isAuthenticated &&
		isSuccess &&
		!curtainIsActive &&
		!dismissed &&
		release !== undefined &&
		shouldShowReleaseVideo(
			me?.settings?.[RELEASE_VIDEO_SEEN_KEY],
			release.version,
		);

	const close = () => {
		setDismissed(true);
		if (release) markSeen.mutate(release.version);
	};

	if (!release) return null;

	const embedUrl = youtubeEmbedUrl(release.videoUrl);

	return (
		<Modal.Root
			centered
			onClose={close}
			opened={opened}
			size="lg"
			transitionProps={{ duration: prefersReducedMotion ? 0 : 200 }}
		>
			<Modal.Overlay
				backgroundOpacity={0.55}
				blur={prefersReducedMotion ? 0 : 8}
			/>
			<Modal.Content
				aria-labelledby={titleId}
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Modal.Header style={{ backgroundColor: "var(--app-background)" }}>
					<Modal.CloseButton
						aria-label={t`Close and go to dembrane`}
						className={styles.closeButton}
						size="lg"
					/>
				</Modal.Header>
				<Modal.Body>
					<Stack gap="lg">
						{embedUrl ? (
							<div className={styles.videoFrame}>
								<iframe
									allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share"
									allowFullScreen
									className={styles.video}
									src={embedUrl}
									title={t`Release video`}
								/>
							</div>
						) : null}

						<h2 className={styles.title} id={titleId}>
							{release.title}
						</h2>

						<div className={styles.body}>
							<ReactMarkdown
								components={{
									a: ({ children, href }) => (
										<a href={href} rel="noopener noreferrer" target="_blank">
											{children}
										</a>
									),
								}}
								remarkPlugins={[remarkGfm]}
							>
								{release.description}
							</ReactMarkdown>
						</div>

						<a
							className={`${styles.body} ${styles.link}`}
							href={CHANGELOG_DOCS_URL}
							rel="noopener noreferrer"
							target="_blank"
						>
							<Trans>see earlier releases</Trans>
						</a>
					</Stack>
				</Modal.Body>
			</Modal.Content>
		</Modal.Root>
	);
};
