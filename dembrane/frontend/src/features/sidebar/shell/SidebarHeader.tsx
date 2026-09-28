import { t } from "@lingui/core/macro";
import { ActionIcon } from "@mantine/core";
import { SidebarSimple } from "@phosphor-icons/react";
import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";
import { cn } from "@/lib/utils";
import { useSidebarState } from "../hooks/useSidebarState";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "./rail";

export const SidebarHeader = () => {
	const { setCollapsed } = useSidebarState();
	const inRail = useInRail();

	if (inRail) {
		// The logomark sits where the full logo does, as a favicon, and the
		// button that opens the menu sits directly under it.
		return (
			<div
				className="flex shrink-0 flex-col items-center border-b pb-1.5"
				style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
			>
				<div className="flex h-[57px] items-center">
					<RailTip label="dembrane home">
						<I18nLink
							to="/o"
							className={cn(
								RAIL_ITEM_CLASS,
								"transition-opacity hover:opacity-80",
							)}
							aria-label="dembrane home"
						>
							<Logo hideTitle hideEnvBadge h="24px" />
						</I18nLink>
					</RailTip>
				</div>
				<RailTip label={t`Open menu`}>
					<button
						type="button"
						onClick={() => setCollapsed(false)}
						aria-label={t`Open menu`}
						className={cn(RAIL_ITEM_CLASS, "hover:bg-black/[0.04]")}
						style={{ color: "rgba(45, 45, 44, 0.75)" }}
					>
						<SidebarSimple size={18} aria-hidden="true" />
					</button>
				</RailTip>
			</div>
		);
	}

	return (
		<div
			className="flex h-[57px] shrink-0 items-center justify-between border-b pl-[12.5px] pr-3"
			style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
		>
			<I18nLink
				to="/o"
				className="flex items-center gap-2 transition-opacity hover:opacity-80"
				aria-label="dembrane home"
			>
				<Logo hideTitle={false} />
			</I18nLink>

			<ActionIcon
				variant="subtle"
				color="gray"
				onClick={() => setCollapsed(true)}
				aria-label="Collapse sidebar"
				size={28}
			>
				<SidebarSimple size={18} />
			</ActionIcon>
		</div>
	);
};
