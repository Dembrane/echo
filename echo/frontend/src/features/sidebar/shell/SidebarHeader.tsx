import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";
import { ActionIcon } from "@mantine/core";
import { CaretLeft } from "@phosphor-icons/react";
import { useV2Me } from "@/hooks/useV2Me";
import { useSidebarState } from "../hooks/useSidebarState";

export const SidebarHeader = () => {
	const { data: me } = useV2Me();
	const { setCollapsed } = useSidebarState();
	const isCollapsible = !!me?.settings?.enable_collapsible_sidebar;

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

			{isCollapsible && (
				<ActionIcon
					variant="subtle"
					color="gray"
					onClick={() => setCollapsed(true)}
					aria-label="Collapse sidebar"
					size={28}
				>
					<CaretLeft size={18} />
				</ActionIcon>
			)}
		</div>
	);
};
