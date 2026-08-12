import { t } from "@lingui/core/macro";
import { Modal, Stack } from "@mantine/core";
import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticated } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL } from "@/config";
import { usePrefersReducedMotion } from "@/features/sidebar/animations/motion";
import { useLanguage } from "@/hooks/useLanguage";
import { useV2Me } from "@/hooks/useV2Me";
import styles from "./ReleaseVideoModal.module.css";
import {
	latestRelease,
	playerBridgeUrl,
	RELEASE_VIDEO_SEEN_KEY,
	shouldShowReleaseVideo,
	YOUTUBE_EMBED_ORIGIN,
	youtubeEmbedUrl,
} from "./releaseVideo";
import {
	createWatchTracker,
	playerInfoFromMessage,
	type WatchEvent,
	type WatchTracker,
} from "./videoWatchTracker";

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
 * Seen means dismissed, not watched. After that it only comes back when the
 * user asks for it from the sidebar's "What's new".
 *
 * Engagement is measured, not stored. PostHog events cover the showing
 * (whats_new_modal_opened, with an auto/manual trigger), playback
 * (whats_new_video_started, whats_new_video_progress at the milestones,
 * whats_new_video_completed) and the roll-up (whats_new_modal_closed).
 * Playback state comes from the embed's own postMessage stream (enablejsapi=1
 * plus a `listening` handshake), so no YouTube script is loaded, `script-src`
 * stays untouched, and the frame stays on the nocookie origin. Milestones go
 * out the moment they are crossed, so a tab closed mid-video still leaves a
 * record; pagehide flushes the summary for the walk-away case.
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

/** The id the widget echoes back in every message; one player, one constant. */
const PLAYER_BRIDGE_ID = "release-video-modal";

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
	const posthog = usePostHog();
	const { language } = useLanguage();

	// Closes the modal immediately, without waiting on the network. If the write
	// fails the modal returns on the next load, which is the recoverable
	// direction: better a second showing than a dismissal that will not stick.
	const [dismissed, setDismissed] = useState(false);

	const release = latestRelease();
	const releaseVersion = release?.version;

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

	const embedUrl = release ? youtubeEmbedUrl(release.videoUrl) : null;
	const embedSrc = embedUrl
		? playerBridgeUrl(embedUrl, window.location.origin)
		: null;

	const iframeRef = useRef<HTMLIFrameElement>(null);
	const trackerRef = useRef<WatchTracker>(createWatchTracker());
	const openedAtRef = useRef(0);
	const openRecordedRef = useRef(false);
	const summarySentRef = useRef(false);
	const triggerRef = useRef<"auto" | "manual">("auto");

	// One record per showing. The guard absorbs StrictMode re-runs and
	// dependency refires, so a showing captures exactly once, and reopening
	// from the sidebar starts a fresh one.
	useEffect(() => {
		if (!opened) {
			openRecordedRef.current = false;
			return;
		}
		if (openRecordedRef.current || !releaseVersion) return;
		openRecordedRef.current = true;

		trackerRef.current = createWatchTracker();
		openedAtRef.current = Date.now();
		summarySentRef.current = false;
		triggerRef.current = requested ? "manual" : "auto";

		posthog?.capture("whats_new_modal_opened", {
			language,
			// How deep into the visit the modal appeared. Deliberately not a
			// time-since-login guess from the client: the person's real login
			// and activity history already lives in PostHog, so recency is a
			// query-side join against user_logged_in / prior events.
			seconds_since_page_load: Math.round(performance.now() / 1000),
			trigger: triggerRef.current,
			version: releaseVersion,
		});
	}, [opened, language, posthog, releaseVersion, requested]);

	// Kept in a ref so the message listener below never holds a stale closure
	// and never has to re-subscribe on a render.
	const captureWatchEvent = (watchEvent: WatchEvent) => {
		const base = {
			language,
			trigger: triggerRef.current,
			version: releaseVersion,
		};
		if (watchEvent.type === "started") {
			posthog?.capture("whats_new_video_started", {
				...base,
				seconds_after_open: Math.round(
					(Date.now() - openedAtRef.current) / 1000,
				),
			});
			return;
		}
		if (watchEvent.type === "milestone") {
			posthog?.capture("whats_new_video_progress", {
				...base,
				milestone_percent: watchEvent.milestone,
			});
			return;
		}
		const snap = trackerRef.current.snapshot();
		posthog?.capture("whats_new_video_completed", {
			...base,
			video_duration_seconds: snap.durationSeconds,
			video_watched_seconds: snap.watchedSeconds,
		});
	};
	const captureWatchEventRef = useRef(captureWatchEvent);
	useEffect(() => {
		captureWatchEventRef.current = captureWatchEvent;
	});

	const flushSummary = (reason: "dismissed" | "pagehide") => {
		if (summarySentRef.current || !openRecordedRef.current) return;
		summarySentRef.current = true;
		const snap = trackerRef.current.snapshot();
		posthog?.capture("whats_new_modal_closed", {
			language,
			modal_open_seconds: Math.round((Date.now() - openedAtRef.current) / 1000),
			reason,
			trigger: triggerRef.current,
			version: releaseVersion,
			video_duration_seconds: snap.durationSeconds,
			video_max_percent: snap.maxPercent,
			video_percent_watched: snap.percentWatched,
			video_watched: snap.started,
			video_watched_seconds: snap.watchedSeconds,
		});
	};
	const flushSummaryRef = useRef(flushSummary);
	useEffect(() => {
		flushSummaryRef.current = flushSummary;
	});

	// The listening handshake wakes the widget: it answers with initialDelivery
	// and then streams infoDelivery while playing. The hello is resent on an
	// interval until the first message lands, because the frame may still be
	// booting when the modal opens.
	useEffect(() => {
		if (!opened || !embedSrc) return;

		let handshaken = false;

		const postListening = () => {
			iframeRef.current?.contentWindow?.postMessage(
				JSON.stringify({
					channel: "widget",
					event: "listening",
					id: PLAYER_BRIDGE_ID,
				}),
				YOUTUBE_EMBED_ORIGIN,
			);
		};

		const onMessage = (event: MessageEvent) => {
			if (event.origin !== YOUTUBE_EMBED_ORIGIN) return;
			if (
				!iframeRef.current ||
				event.source !== iframeRef.current.contentWindow
			) {
				return;
			}
			handshaken = true;
			const info = playerInfoFromMessage(event.data);
			if (!info) return;
			for (const watchEvent of trackerRef.current.handleInfo(info)) {
				captureWatchEventRef.current(watchEvent);
			}
		};

		window.addEventListener("message", onMessage);
		postListening();
		const handshake = window.setInterval(() => {
			if (handshaken) {
				window.clearInterval(handshake);
				return;
			}
			postListening();
		}, 500);

		return () => {
			window.removeEventListener("message", onMessage);
			window.clearInterval(handshake);
		};
	}, [opened, embedSrc]);

	// Milestones above are durable on their own; this recovers the close
	// summary when the tab goes instead of the modal. posthog-js flushes its
	// queue with sendBeacon on pagehide, so the capture still makes it out.
	useEffect(() => {
		if (!opened) return;
		const onPageHide = () => flushSummaryRef.current("pagehide");
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [opened]);

	const close = () => {
		flushSummary("dismissed");
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
						{embedSrc ? (
							<div className={styles.videoFrame}>
								<iframe
									allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share"
									allowFullScreen
									className={styles.video}
									ref={iframeRef}
									src={embedSrc}
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

						<p className={styles.note}>{release.note}</p>
					</Stack>
				</Modal.Body>
			</Modal.Content>
		</Modal.Root>
	);
};
