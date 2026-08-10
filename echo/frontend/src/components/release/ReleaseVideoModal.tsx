import { t } from "@lingui/core/macro";
import { Modal, Stack } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticated } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL } from "@/config";
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
 * It renders getReleases()[0] and nothing else. There is no history to scroll,
 * so the modal stays a single thing to look at and then dismiss.
 *
 * Every line of copy comes off that release object (header line, title,
 * description, closing note); none of it is written here. Shipping a release is
 * an edit to releases.ts plus the usual translation pass.
 *
 * Mounted in HelpBlock, next to the "What's new" button that reopens it, so the
 * one piece of shared state stays local. HelpBlock renders for every signed-in
 * user and survives a collapsed sidebar (SidebarShell keeps its children
 * mounted at width 0), which is what the automatic showing needs.
 *
 * It sits inside BaseLayout's TransitionCurtainProvider and refuses to paint
 * while that curtain is active, which covers the in-app transitions (theme
 * change, sign out) that run in this provider. Note that the LOGIN curtain
 * belongs to a different provider instance inside AuthLayout, and AuthLayout
 * unmounts on the post-login navigate, so there is no overlap to guard against
 * there.
 *
 * Dismissing is the whole interaction: click the backdrop, press escape, or hit
 * the close button, and the newest version is written to app_user.settings.
 * Seen means dismissed, not watched, so no YouTube Player API is loaded. After
 * that it only comes back when the user asks for it from the sidebar's
 * "What's new".
 *
 * Typography is held to two combinations, both defined in the adjacent
 * stylesheet: the two titles at one size, the copy below them at the other.
 * Nothing here sets a font size, weight, colour or style.
 */
interface ReleaseVideoModalProps {
	/** Set by the sidebar's "What's new", which ignores the seen gate. */
	requested?: boolean;
	onRequestedClose?: () => void;
}

export const ReleaseVideoModal = ({
	requested = false,
	onRequestedClose,
}: ReleaseVideoModalProps) => {
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
		release !== undefined &&
		!curtainIsActive &&
		(requested ||
			(isAuthenticated &&
				isSuccess &&
				!dismissed &&
				shouldShowReleaseVideo(
					me?.settings?.[RELEASE_VIDEO_SEEN_KEY],
					release.version,
				)));

	const close = () => {
		setDismissed(true);
		onRequestedClose?.();
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
			<Modal.Overlay backgroundOpacity={0.6} />
			<Modal.Content
				aria-labelledby={titleId}
				styles={{ content: { backgroundColor: "var(--app-background)" } }}
			>
				<Modal.Header
					style={{
						backgroundColor: "var(--app-background)",
						padding: "1.5rem 2rem 1rem",
					}}
				>
					<Modal.Title className={styles.headerTitle}>
						{release.headerTitle}
					</Modal.Title>
					<Modal.CloseButton
						aria-label={t`Close and go to dembrane`}
						className={styles.closeButton}
						size="lg"
					/>
				</Modal.Header>
				<Modal.Body style={{ padding: "0 2rem 2rem" }}>
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

						<p className={styles.note}>
							{release.note}
						</p>
					</Stack>
				</Modal.Body>
			</Modal.Content>
		</Modal.Root>
	);
};
