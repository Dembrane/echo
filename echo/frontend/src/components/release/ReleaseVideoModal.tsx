import { t } from "@lingui/core/macro";
import { Modal, Stack } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticated } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { useLanguage } from "@/hooks/useLanguage";
import { API_BASE_URL } from "@/config";
import { usePrefersReducedMotion } from "@/features/sidebar/animations/motion";
import { useV2Me } from "@/hooks/useV2Me";
import posthog from "posthog-js";
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

	const { language } = useLanguage();

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

	const iframeRef = useRef<HTMLIFrameElement>(null);
	const playerRef = useRef<any>(null);
	const playStartTime = useRef<number | null>(null);
	const watchedSeconds = useRef<number>(0);
	const hasPlayed = useRef<boolean>(false);

	const getLastLoginTime = (): number => {
		let val = localStorage.getItem("last_login_time");
		if (!val) {
			const nowStr = Date.now().toString();
			try {
				localStorage.setItem("last_login_time", nowStr);
			} catch {}
			val = nowStr;
		}
		return parseInt(val, 10);
	};

	const getSecondsSinceLogin = (): number | null => {
		const lastLogin = getLastLoginTime();
		return lastLogin ? Math.floor((Date.now() - lastLogin) / 1000) : null;
	};

	// Capture modal open event
	useEffect(() => {
		if (opened && release) {
			playStartTime.current = null;
			watchedSeconds.current = 0;
			hasPlayed.current = false;

			posthog?.capture("whats_new_modal_opened", {
				language,
				seconds_since_login: getSecondsSinceLogin(),
				version: release.version,
			});
		}
	}, [opened, release?.version, language]);

	const embedUrl = release ? youtubeEmbedUrl(release.videoUrl) : null;
	const embedUrlWithApi = embedUrl ? `${embedUrl}&enablejsapi=1` : null;

	// Load YouTube API and track play state
	useEffect(() => {
		if (!opened || !embedUrlWithApi || !release) return;

		if (!(window as any).YT) {
			const tag = document.createElement("script");
			tag.src = "https://www.youtube.com/iframe_api";
			const firstScriptTag = document.getElementsByTagName("script")[0];
			firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);
		}

		let checkInterval: NodeJS.Timeout;
		let initialized = false;

		const initPlayer = () => {
			const anyWindow = window as any;
			if (anyWindow.YT && anyWindow.YT.Player && iframeRef.current && !initialized) {
				initialized = true;
				playerRef.current = new anyWindow.YT.Player(iframeRef.current, {
					events: {
						onStateChange: (event: any) => {
							const state = event.data;
							// 1 is PLAYING
							if (state === 1) {
								if (!hasPlayed.current) {
									hasPlayed.current = true;
									posthog?.capture("whats_new_video_started", {
										language,
										seconds_since_login: getSecondsSinceLogin(),
										version: release.version,
									});
								}
								playStartTime.current = Date.now();
							} else {
								// PAUSED (2), ENDED (0), etc.
								if (playStartTime.current !== null) {
									const elapsed = (Date.now() - playStartTime.current) / 1000;
									watchedSeconds.current += elapsed;
									playStartTime.current = null;
								}
							}
						},
					},
				});
				clearInterval(checkInterval);
			}
		};

		const anyWindow = window as any;
		if (anyWindow.YT && anyWindow.YT.Player) {
			initPlayer();
		} else {
			checkInterval = setInterval(initPlayer, 100);
		}

		return () => {
			if (checkInterval) clearInterval(checkInterval);
			if (playerRef.current && typeof playerRef.current.destroy === "function") {
				try {
					playerRef.current.destroy();
				} catch {}
			}
			playerRef.current = null;
			playStartTime.current = null;
		};
	}, [opened, embedUrlWithApi, release?.version, language]);

	const close = () => {
		if (playStartTime.current !== null) {
			const elapsed = (Date.now() - playStartTime.current) / 1000;
			watchedSeconds.current += elapsed;
			playStartTime.current = null;
		}

		let videoDuration = 0;
		try {
			if (playerRef.current && typeof playerRef.current.getDuration === "function") {
				videoDuration = playerRef.current.getDuration();
			}
		} catch (e) {
			console.error("Failed to get video duration:", e);
		}

		const percentWatched = videoDuration > 0
			? Math.min(100, Math.round((watchedSeconds.current / videoDuration) * 100))
			: 0;

		if (release) {
			posthog?.capture("whats_new_modal_closed", {
				language,
				seconds_since_login: getSecondsSinceLogin(),
				version: release.version,
				video_watched_seconds: Math.round(watchedSeconds.current * 10) / 10,
				video_duration_seconds: videoDuration,
				video_percent_watched: percentWatched,
				video_watched: hasPlayed.current,
			});
		}

		setDismissed(true);
		onRequestedClose?.();
		if (release) markSeen.mutate(release.version);
	};

	if (!release) return null;

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
						{embedUrlWithApi ? (
							<div className={styles.videoFrame}>
								<iframe
									ref={iframeRef}
									allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share"
									allowFullScreen
									className={styles.video}
									src={embedUrlWithApi}
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
