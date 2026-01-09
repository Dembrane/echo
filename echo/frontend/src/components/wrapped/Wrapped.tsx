import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import {
	IconChevronLeft,
	IconChevronRight,
	IconMessageCircle,
	IconMicrophone,
	IconSparkles,
	IconUsers,
	IconX,
} from "@tabler/icons-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { useWrappedStats, type WrappedStats } from "./hooks";
import "./wrapped.css";

interface WrappedProps {
	isOpen: boolean;
	onClose: () => void;
}

// Slide components
const IntroSlide = ({ userName }: { userName: string }) => {
	const previousYear = new Date().getFullYear() - 1;

	return (
		<Stack className="slide-content" align="center" justify="center" gap="xl">
			<motion.div
				initial={{ rotate: -180, scale: 0 }}
				animate={{ rotate: 0, scale: 1 }}
				transition={{ delay: 0.2, duration: 1, type: "spring" }}
			>
				<IconSparkles size={80} className="text-accent animate-pulse" />
			</motion.div>
			<motion.div
				initial={{ opacity: 0, y: 50 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.5 }}
			>
				<Title order={1} className="wrapped-title">
					<Trans>Hey {userName}!</Trans>
				</Title>
			</motion.div>
			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ delay: 0.8 }}
			>
				<Text size="xl" className="wrapped-subtitle">
					<Trans>Let's look at your Dembrane journey</Trans>
				</Text>
			</motion.div>
			<motion.div
				initial={{ opacity: 0, scale: 0.8 }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{ delay: 1.2 }}
				className="wrapped-year"
			>
				<Title order={2} className="gradient-text">
					{previousYear}
				</Title>
			</motion.div>
		</Stack>
	);
};

const ProjectsSlide = ({ stats }: { stats: WrappedStats }) => (
	<Stack className="slide-content" align="center" justify="center" gap="xl">
		<motion.div
			initial={{ scale: 0 }}
			animate={{ scale: 1 }}
			transition={{ duration: 0.8, type: "spring" }}
		>
			<div className="stat-circle projects">
				<motion.span
					className="stat-number"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ delay: 0.5 }}
				>
					{stats.totalProjects}
				</motion.span>
			</div>
		</motion.div>
		<motion.div
			initial={{ opacity: 0, y: 30 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: 0.6 }}
		>
			<Title order={2} ta="center" className="wrapped-stat-label">
				<Trans>Projects Created</Trans>
			</Title>
		</motion.div>
		{stats.mostActiveProject && (
			<motion.div
				initial={{ opacity: 0, y: 20 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 1 }}
				className="highlight-box"
			>
				<Text size="lg" ta="center">
					<Trans>Your most active project:</Trans>
				</Text>
				<Text size="xl" fw={700} ta="center" className="accent-text">
					{stats.mostActiveProject.name}
				</Text>
				<Text size="sm" ta="center" className="stat-label-inline">
					{stats.mostActiveProject.conversationCount}{" "}
					<Trans>conversations</Trans>
				</Text>
			</motion.div>
		)}
	</Stack>
);

const ConversationsSlide = ({ stats }: { stats: WrappedStats }) => (
	<Stack className="slide-content" align="center" justify="center" gap="xl">
		<motion.div
			initial={{ opacity: 0, x: -100 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.8, type: "spring" }}
		>
			<Group align="center" gap="lg">
				<IconUsers size={60} className="text-accent" />
				<div className="stat-display">
					<motion.span
						className="stat-number-inline"
						initial={{ scale: 0 }}
						animate={{ scale: 1 }}
						transition={{ delay: 0.3, type: "spring" }}
					>
						{stats.totalConversations}
					</motion.span>
					<Text size="xl" className="stat-label-inline">
						<Trans>Conversations</Trans>
					</Text>
				</div>
			</Group>
		</motion.div>

		<motion.div
			initial={{ opacity: 0, x: 100 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay: 0.4, duration: 0.8, type: "spring" }}
		>
			<Group align="center" gap="lg">
				<IconMicrophone size={60} className="text-accent" />
				<div className="stat-display">
					<motion.span
						className="stat-number-inline"
						initial={{ scale: 0 }}
						animate={{ scale: 1 }}
						transition={{ delay: 0.7, type: "spring" }}
					>
						{stats.totalRecordingMinutes}
					</motion.span>
					<Text size="xl" className="stat-label-inline">
						<Trans>Minutes Recorded</Trans>
					</Text>
				</div>
			</Group>
		</motion.div>

		{stats.longestConversation && stats.longestConversation.duration > 0 && (
			<motion.div
				initial={{ opacity: 0, y: 30 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 1.2 }}
				className="highlight-box"
			>
				<Text size="lg" ta="center">
					<Trans>Longest conversation:</Trans>
				</Text>
				<Text size="xl" fw={700} ta="center" className="accent-text">
					{Math.round(stats.longestConversation.duration / 60)}{" "}
					<Trans>minutes</Trans>
				</Text>
			</motion.div>
		)}
	</Stack>
);

const ChatsSlide = ({ stats }: { stats: WrappedStats }) => (
	<Stack className="slide-content" align="center" justify="center" gap="xl">
		<motion.div
			initial={{ opacity: 0, rotate: -10, scale: 0.8 }}
			animate={{ opacity: 1, rotate: 0, scale: 1 }}
			transition={{ duration: 1, type: "spring" }}
		>
			<IconMessageCircle size={80} className="text-accent" />
		</motion.div>

		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ delay: 0.5 }}
		>
			<Title order={2} ta="center" className="wrapped-stat-label">
				<Trans>Chats</Trans>
			</Title>
		</motion.div>

		<motion.div
			className="stats-grid"
			initial={{ opacity: 0, y: 30 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ delay: 0.8 }}
		>
			<div className="stat-card">
				<motion.span
					className="stat-card-number"
					initial={{ scale: 0 }}
					animate={{ scale: 1 }}
					transition={{ delay: 1, type: "spring" }}
				>
					{stats.totalChats}
				</motion.span>
				<Text size="sm">
					<Trans>Chats Created</Trans>
				</Text>
			</div>
			<div className="stat-card">
				<motion.span
					className="stat-card-number"
					initial={{ scale: 0 }}
					animate={{ scale: 1 }}
					transition={{ delay: 1.2, type: "spring" }}
				>
					{stats.totalChatMessages}
				</motion.span>
				<Text size="sm">
					<Trans>Chat Messages</Trans>
				</Text>
			</div>
		</motion.div>
	</Stack>
);

const SummarySlide = ({
	stats,
	userName,
}: {
	stats: WrappedStats;
	userName: string;
}) => {
	const previousYear = new Date().getFullYear() - 1;

	return (
		<Stack className="slide-content" align="center" justify="center" gap="xl">
			<motion.div
				initial={{ scale: 0 }}
				animate={{ scale: 1 }}
				transition={{ duration: 0.8, type: "spring" }}
			>
				<Title order={1} ta="center" className="wrapped-title">
					<Trans>Your {previousYear} in Numbers</Trans>
				</Title>
			</motion.div>

			<motion.div
				className="summary-stats"
				initial={{ opacity: 0, y: 30 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.4 }}
			>
				<div className="summary-row">
					<span className="summary-value">{stats.totalProjects}</span>
					<span className="summary-label">
						<Trans>Projects</Trans>
					</span>
				</div>
				<div className="summary-row">
					<span className="summary-value">{stats.totalConversations}</span>
					<span className="summary-label">
						<Trans>Conversations</Trans>
					</span>
				</div>
				<div className="summary-row">
					<span className="summary-value">{stats.totalRecordingMinutes}</span>
					<span className="summary-label">
						<Trans>Total Conversation Minutes</Trans>
					</span>
				</div>
				<div className="summary-row">
					<span className="summary-value">{stats.totalChatMessages}</span>
					<span className="summary-label">
						<Trans>Chat Messages</Trans>
					</span>
				</div>
			</motion.div>

			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ delay: 1 }}
			>
				<Text size="xl" ta="center" className="wrapped-subtitle">
					<Trans>Thanks for being part of Dembrane, {userName}!</Trans>
				</Text>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 1.4 }}
				className="sparkle-container"
			>
				{[...Array(5)].map((_, i) => (
					<motion.div
						key={i}
						className="floating-sparkle"
						animate={{
							rotate: [0, 180, 360],
							scale: [1, 1.2, 1],
							y: [-10, 10, -10],
						}}
						transition={{
							delay: i * 0.2,
							duration: 2 + i * 0.3,
							repeat: Number.POSITIVE_INFINITY,
						}}
					>
						<IconSparkles size={24} />
					</motion.div>
				))}
			</motion.div>
		</Stack>
	);
};

const slides = [
	{ Component: IntroSlide, id: "intro" },
	{ Component: ProjectsSlide, id: "projects" },
	{ Component: ConversationsSlide, id: "conversations" },
	{ Component: ChatsSlide, id: "chats" },
	{ Component: SummarySlide, id: "summary" },
];

export const Wrapped = ({ isOpen, onClose }: WrappedProps) => {
	const [currentSlide, setCurrentSlide] = useState(0);
	const [direction, setDirection] = useState(1);
	const { data: user } = useCurrentUser();
	const { data: stats, isLoading, isError } = useWrappedStats(isOpen);

	const userName = user?.first_name ?? t`Explorer`;

	const goToNext = useCallback(() => {
		if (currentSlide < slides.length - 1) {
			setDirection(1);
			setCurrentSlide((prev) => prev + 1);
		}
	}, [currentSlide]);

	const goToPrev = useCallback(() => {
		if (currentSlide > 0) {
			setDirection(-1);
			setCurrentSlide((prev) => prev - 1);
		}
	}, [currentSlide]);

	const handleClose = useCallback(() => {
		setCurrentSlide(0);
		onClose();
	}, [onClose]);

	// Keyboard navigation
	useHotkeys([
		["ArrowRight", goToNext],
		["ArrowLeft", goToPrev],
		["Escape", handleClose],
	]);

	// Reset slide when opening
	useEffect(() => {
		if (isOpen) {
			setCurrentSlide(0);
		}
	}, [isOpen]);

	if (!isOpen) return null;

	const slideVariants = {
		center: {
			opacity: 1,
			x: 0,
		},
		enter: (direction: number) => ({
			opacity: 0,
			x: direction > 0 ? "100%" : "-100%",
		}),
		exit: (direction: number) => ({
			opacity: 0,
			x: direction > 0 ? "-100%" : "100%",
		}),
	};

	return (
		<motion.div
			className="wrapped-overlay"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
		>
			<Box className="wrapped-container">
				{/* Close button */}
				<Button
					variant="subtle"
					color="white"
					className="wrapped-close"
					onClick={handleClose}
					leftSection={<IconX size={20} />}
				>
					<Trans>Close</Trans>
				</Button>

				{/* Progress indicator */}
				<div className="wrapped-progress">
					{slides.map((_, index) => (
						<motion.div
							key={index}
							className={`progress-dot ${index === currentSlide ? "active" : ""} ${index < currentSlide ? "completed" : ""}`}
							whileHover={{ scale: 1.2 }}
							onClick={() => {
								setDirection(index > currentSlide ? 1 : -1);
								setCurrentSlide(index);
							}}
						/>
					))}
				</div>

				{/* Content */}
				{isLoading ? (
					<Center className="h-full">
						<Stack align="center" gap="md">
							<Loader color="white" size="xl" />
							<Text c="white" size="lg">
								<Trans>Preparing your wrapped...</Trans>
							</Text>
						</Stack>
					</Center>
				) : isError || !stats ? (
					<Center className="h-full">
						<Stack align="center" gap="md">
							<Text c="white" size="lg">
								<Trans>Something went wrong. Please try again.</Trans>
							</Text>
							<Button variant="light" onClick={handleClose}>
								<Trans>Close</Trans>
							</Button>
						</Stack>
					</Center>
				) : (
					<AnimatePresence mode="wait" custom={direction}>
						<motion.div
							key={currentSlide}
							custom={direction}
							variants={slideVariants}
							initial="enter"
							animate="center"
							exit="exit"
							transition={{
								opacity: { duration: 0.2 },
								x: { damping: 30, stiffness: 300, type: "spring" },
							}}
							className="wrapped-slide"
						>
							{slides[currentSlide].id === "intro" && (
								<IntroSlide userName={userName} />
							)}
							{slides[currentSlide].id === "projects" && (
								<ProjectsSlide stats={stats} />
							)}
							{slides[currentSlide].id === "conversations" && (
								<ConversationsSlide stats={stats} />
							)}
							{slides[currentSlide].id === "chats" && (
								<ChatsSlide stats={stats} />
							)}
							{slides[currentSlide].id === "summary" && (
								<SummarySlide stats={stats} userName={userName} />
							)}
						</motion.div>
					</AnimatePresence>
				)}

				{/* Navigation arrows */}
				{!isLoading && !isError && stats && (
					<>
						{currentSlide > 0 && (
							<motion.button
								className="wrapped-nav wrapped-nav-prev"
								onClick={goToPrev}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
							>
								<IconChevronLeft size={32} />
							</motion.button>
						)}
						{currentSlide < slides.length - 1 && (
							<motion.button
								className="wrapped-nav wrapped-nav-next"
								onClick={goToNext}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
							>
								<IconChevronRight size={32} />
							</motion.button>
						)}
					</>
				)}
			</Box>
		</motion.div>
	);
};
