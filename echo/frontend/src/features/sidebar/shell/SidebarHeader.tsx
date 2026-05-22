import { Link } from "react-router";
import { Logo } from "@/components/common/Logo";

export const SidebarHeader = () => {
	return (
		<div
			className="flex h-[46px] shrink-0 items-center border-b px-3"
			style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
		>
			<Link
				to="/"
				className="flex items-center gap-2 transition-opacity hover:opacity-80"
				aria-label="dembrane home"
			>
				<Logo hideTitle={false} />
			</Link>
		</div>
	);
};
