import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";

export const SidebarHeader = () => {
	return (
		<div
			className="flex h-[57px] shrink-0 items-center border-b pl-[12.5px] pr-3"
			style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
		>
			<I18nLink
				to="/"
				className="flex items-center gap-2 transition-opacity hover:opacity-80"
				aria-label="dembrane home"
			>
				<Logo hideTitle={false} />
			</I18nLink>
		</div>
	);
};
