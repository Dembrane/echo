import { CaretRight, type Icon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { NavLink, useMatch, useParams, useResolvedPath } from "react-router";
import { brandColors, roles } from "@/colors";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { cn } from "@/lib/utils";
import { TIMINGS } from "../animations/motion";
import { useSidebarView } from "../hooks/useSidebarView";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "../shell/rail";

interface NavItemProps {
	to: string;
	label: ReactNode;
	icon?: Icon;
	pushes?: boolean;
	end?: boolean;
	badge?: ReactNode;
	badgeTone?: "muted" | "notification" | "pending";
	active?: boolean;
	muted?: boolean;
	accent?: string;
	/** Render as a non-navigable, greyed-out row (e.g. a planned page). */
	disabled?: boolean;
	/** Indent to align with an icon-bearing row's label, for sub-rows. */
	inset?: boolean;
}

export const BADGE_TONES = {
	muted: {
		backgroundColor: roles.quiet,
		color: roles.muted,
	},
	notification: {
		backgroundColor: roles.actionTint,
		color: roles.action,
	},
	// Pending action (e.g. high-risk training nudge): the warning tint, with
	// graphite text.
	pending: {
		backgroundColor: roles.warningTint,
		color: roles.text,
	},
} as const;

// Rail dots for badges that ask for attention. Counts and labels ("Beta")
// move into the tooltip instead.
const RAIL_DOT_COLORS = {
	notification: roles.action,
	pending: brandColors.yellow[3],
} as const;

function useLocalePath(to: string): string {
	const { language } = useParams<{ language?: string }>();
	const { language: i18nLanguage } = useLanguage();
	const finalLanguage = language ?? i18nLanguage;
	if (
		to.startsWith("./") ||
		to.startsWith("../") ||
		to === "." ||
		to === ".."
	) {
		return to;
	}
	const alreadyPrefixed = SUPPORTED_LANGUAGES.some(
		(lang) => to === `/${lang}` || to.startsWith(`/${lang}/`),
	);
	if (alreadyPrefixed || !finalLanguage) return to;
	return `/${finalLanguage}${to}`;
}

export const NavItem = ({
	to,
	label,
	icon: Icon,
	pushes,
	end,
	badge,
	badgeTone = "muted",
	active: forcedActive,
	muted,
	accent,
	disabled,
	inset,
}: NavItemProps) => {
	const localePath = useLocalePath(to);
	const resolved = useResolvedPath(localePath);
	const match = useMatch({ end: end ?? false, path: resolved.pathname });
	// An overlay leaves the pathname alone, so a path-matched row would stay
	// active under it and fight the overlay's row for the shared pill layoutId.
	const { overlay } = useSidebarView();
	const active = forcedActive ?? (match != null && !overlay);
	const inRail = useInRail();

	if (inRail) {
		// The rail is icons only; a row without one (an inset sub-row) stays in
		// the full sidebar.
		if (!Icon) return null;
		const name = (
			<>
				{label}
				{badge != null ? <> {badge}</> : null}
			</>
		);
		const dot =
			badge != null && badgeTone !== "muted" ? (
				<span
					data-testid="rail-badge-dot"
					aria-hidden="true"
					className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--app-background)]"
					style={{ backgroundColor: RAIL_DOT_COLORS[badgeTone] }}
				/>
			) : null;

		if (disabled) {
			return (
				<RailTip label={name}>
					<div
						className={cn(
							RAIL_ITEM_CLASS,
							"app-muted cursor-not-allowed opacity-60",
						)}
						style={{ color: "var(--mantine-color-dimmed)" }}
						aria-disabled="true"
					>
						<Icon size={20} aria-hidden="true" />
						<span className="sr-only">{name}</span>
					</div>
				</RailTip>
			);
		}

		return (
			<RailTip label={name}>
				<NavLink
					to={localePath}
					end={end}
					className={cn(
						RAIL_ITEM_CLASS,
						!active && "hover:bg-[var(--app-quiet)]",
						!active && muted && "app-muted",
					)}
					style={{
						color: active
							? (accent ?? roles.action)
							: muted
								? "var(--mantine-color-dimmed)"
								: (accent ?? roles.text),
					}}
				>
					{active && (
						<motion.span
							layoutId="sidebar-active-pill"
							transition={TIMINGS.activePill}
							className="absolute inset-0"
							style={{ backgroundColor: roles.actionTint }}
						/>
					)}
					<Icon size={20} className="relative" aria-hidden="true" />
					<span className="sr-only">{name}</span>
					{dot}
				</NavLink>
			</RailTip>
		);
	}

	if (disabled) {
		return (
			<div
				className="app-muted relative flex h-[30px] cursor-not-allowed items-center gap-2 px-2 text-sm leading-tight opacity-60"
				style={{ color: "var(--mantine-color-dimmed)" }}
				aria-disabled="true"
			>
				<span className="relative flex flex-1 items-center gap-2 truncate">
					{Icon ? <Icon size={16} /> : null}
					<span className="truncate">{label}</span>
				</span>
				{badge != null && (
					<span
						className="relative shrink-0 px-1 py-0.5 text-xs leading-none"
						style={BADGE_TONES[badgeTone]}
					>
						{badge}
					</span>
				)}
			</div>
		);
	}

	return (
		<NavLink
			to={localePath}
			end={end}
			className={cn(
				"relative flex h-[30px] items-center gap-2 text-sm leading-tight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-action)]",
				inset ? "pr-2 pl-8" : "px-2",
				!active && muted && "app-muted",
			)}
			style={{
				color: active
					? (accent ?? roles.action)
					: muted
						? "var(--mantine-color-dimmed)"
						: (accent ?? roles.text),
			}}
		>
			{active && (
				<motion.span
					layoutId="sidebar-active-pill"
					transition={TIMINGS.activePill}
					className="absolute inset-0"
					style={{ backgroundColor: roles.actionTint }}
				/>
			)}
			<span className="relative flex flex-1 items-center gap-2 truncate">
				{Icon ? <Icon size={16} /> : null}
				<span className="truncate">{label}</span>
			</span>
			{/* != null, not truthiness: badge={0} would render a bare "0" */}
			{badge != null && (
				<span
					className="relative shrink-0 px-1 py-0.5 text-xs leading-none"
					style={BADGE_TONES[badgeTone]}
				>
					{badge}
				</span>
			)}
			{pushes && (
				<CaretRight
					size={16}
					className="relative shrink-0"
					style={{ color: "var(--mantine-color-dimmed)" }}
					aria-hidden="true"
				/>
			)}
		</NavLink>
	);
};
