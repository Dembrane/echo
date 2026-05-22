import { CaretRight, type Icon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { NavLink, useMatch, useParams, useResolvedPath } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { TIMINGS } from "../animations/motion";

interface NavItemProps {
	to: string;
	label: ReactNode;
	icon?: Icon;
	pushes?: boolean;
	end?: boolean;
	badge?: ReactNode;
	active?: boolean;
	muted?: boolean;
	accent?: string;
}

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
	active: forcedActive,
	muted,
	accent,
}: NavItemProps) => {
	const localePath = useLocalePath(to);
	const resolved = useResolvedPath(localePath);
	const match = useMatch({ end: end ?? false, path: resolved.pathname });
	const active = forcedActive ?? match != null;

	return (
		<NavLink
			to={localePath}
			end={end}
			className="relative flex h-[30px] items-center gap-2 rounded-md px-2 text-[13px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
			style={{
				color: active
					? (accent ?? "#4169e1")
					: muted
						? "rgba(45, 45, 44, 0.55)"
						: (accent ?? "#2d2d2c"),
			}}
		>
			{active && (
				<motion.span
					layoutId="sidebar-active-pill"
					transition={TIMINGS.activePill}
					className="absolute inset-0 rounded-md"
					style={{ backgroundColor: "rgba(65, 105, 225, 0.08)" }}
				/>
			)}
			<span className="relative flex flex-1 items-center gap-2 truncate">
				{Icon ? <Icon size={16} /> : null}
				<span className="truncate">{label}</span>
			</span>
			{badge && (
				<span
					className="relative shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none"
					style={{
						backgroundColor: "rgba(45, 45, 44, 0.06)",
						color: "rgba(45, 45, 44, 0.55)",
					}}
				>
					{badge}
				</span>
			)}
			{pushes && (
				<CaretRight
					size={13}
					className="relative shrink-0 opacity-45"
					aria-hidden="true"
				/>
			)}
		</NavLink>
	);
};
