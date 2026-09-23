import { Trans } from "@lingui/react/macro";
import { useDisclosure } from "@mantine/hooks";
import {
	Bug,
	ChatCircle,
	EnvelopeSimple,
	Note,
	PlugsConnected,
	Pulse,
	Question,
	Sparkle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { useParams } from "react-router";
import { ReleaseVideoModal } from "@/components/release/ReleaseVideoModal";
import { ENABLE_RELEASE_VIDEO_MODAL, getDocumentationUrl } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { cn } from "@/lib/utils";
import { useHelpModals } from "../hooks/useHelpModals";
import { NavButton } from "../primitives/NavButton";
import { SectionLabel } from "../primitives/SectionLabel";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "../shell/rail";

export const HelpBlock = () => {
	const { language } = useParams();
	const { openFeedback, openReportIssue } = useHelpModals();
	const navigate = useI18nNavigate();
	// The release modal lives here so the button that reopens it can hold its
	// own state. It also shows itself once per release without being asked.
	const [releaseRequested, release] = useDisclosure(false);
	const docUrl = getDocumentationUrl(language);
	const inRail = useInRail();
	const [bubbled, setBubbled] = useState(false);
	const reduced = useReducedMotion();
	const helpButton = useRef<HTMLButtonElement>(null);

	const releaseModal = ENABLE_RELEASE_VIDEO_MODAL ? (
		<ReleaseVideoModal
			requested={releaseRequested}
			onRequestedClose={release.close}
		/>
	) : null;

	const items: { key: string; node: ReactNode }[] = [
		{
			key: "report",
			node: (
				<NavButton
					label={<Trans>Report an issue</Trans>}
					icon={Bug}
					iconColor="var(--mantine-color-primary-6)"
					labelColor="var(--mantine-color-primary-6)"
					onClick={openReportIssue}
				/>
			),
		},
		{
			key: "feedback",
			node: (
				<NavButton
					label={<Trans>Feedback</Trans>}
					icon={ChatCircle}
					iconColor="var(--mantine-color-primary-6)"
					labelColor="var(--mantine-color-primary-6)"
					onClick={openFeedback}
				/>
			),
		},
		{
			key: "agent",
			node: (
				<NavButton
					label={<Trans>Connect your agent</Trans>}
					icon={PlugsConnected}
					badge={<Trans>Beta</Trans>}
					onClick={() => navigate("/connect-agent")}
				/>
			),
		},
		...(ENABLE_RELEASE_VIDEO_MODAL
			? [
					{
						key: "whats-new",
						node: (
							<NavButton
								label={<Trans>What's new</Trans>}
								icon={Sparkle}
								onClick={release.open}
							/>
						),
					},
				]
			: []),
		{
			key: "docs",
			node: (
				<NavButton
					label={<Trans>Documentation</Trans>}
					icon={Note}
					external
					onClick={() => window.open(docUrl, "_blank", "noopener,noreferrer")}
				/>
			),
		},
		{
			key: "status",
			node: (
				<NavButton
					label={<Trans>System status</Trans>}
					icon={Pulse}
					onClick={() => undefined}
					badge={<Trans>Planned</Trans>}
					disabled
				/>
			),
		},
		{
			key: "support",
			node: (
				<NavButton
					label={<Trans>Contact support</Trans>}
					icon={EnvelopeSimple}
					external
					onClick={() => {
						window.location.href = "mailto:support@dembrane.com";
					}}
				/>
			),
		},
	];

	// Seven icons would crowd the rail, and swapping the menu for a Help view
	// would feel like a change of place. So the question mark holds them: a
	// click bubbles them up out of it, nearest first, and a second click or
	// Escape tucks them back in. The release modal stays mounted so it still
	// shows itself once per release.
	if (inRail) {
		const n = items.length;
		return (
			<>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Escape from any bubbled icon closes the group */}
				<div
					className="flex flex-col items-center gap-0.5"
					onKeyDown={(e) => {
						if (e.key === "Escape" && bubbled) {
							setBubbled(false);
							helpButton.current?.focus();
						}
					}}
				>
					<AnimatePresence initial={false}>
						{bubbled &&
							items.map((item, i) => {
								// Distance back down to the question mark, in rows.
								const fromMark = (n - i) * 42;
								return (
									<motion.div
										key={item.key}
										className="flex"
										initial={
											reduced
												? { opacity: 0 }
												: { opacity: 0, scale: 0.3, y: fromMark }
										}
										animate={{ opacity: 1, scale: 1, y: 0 }}
										exit={
											reduced
												? { opacity: 0 }
												: { opacity: 0, scale: 0.3, y: fromMark }
										}
										transition={
											reduced
												? { duration: 0.1 }
												: {
														damping: 26,
														delay: (n - 1 - i) * 0.045,
														stiffness: 520,
														type: "spring",
													}
										}
									>
										{item.node}
									</motion.div>
								);
							})}
					</AnimatePresence>
					<RailTip label={<Trans>Help</Trans>}>
						<button
							ref={helpButton}
							type="button"
							aria-expanded={bubbled}
							onClick={() => setBubbled((b) => !b)}
							className={cn(
								RAIL_ITEM_CLASS,
								"hover:bg-black/[0.04]",
								bubbled && "bg-black/[0.04]",
							)}
							style={{ color: "#2d2d2c" }}
						>
							<Question size={18} aria-hidden="true" />
							<span className="sr-only">
								<Trans>Help</Trans>
							</span>
						</button>
					</RailTip>
				</div>
				{releaseModal}
			</>
		);
	}

	return (
		<>
			<div className="flex flex-col gap-0.5">
				<SectionLabel>
					<Trans>Help</Trans>
				</SectionLabel>
				{items.map((item) => (
					<Fragment key={item.key}>{item.node}</Fragment>
				))}
			</div>
			{releaseModal}
		</>
	);
};
