import { ArrowFatLineUp, ChartBar, Handshake } from "@phosphor-icons/react";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const AdminHomeView = () => {
	return (
		<nav className="flex flex-col gap-0.5 p-1.5">
			<BackButton to="/" label="Admin dashboard" />
			<NavItem
				to="/admin/usage-and-billing"
				label="Usage and billing"
				icon={ChartBar}
			/>
			<NavItem to="/admin/partners" label="Partners" icon={Handshake} />
			<NavItem to="/admin/upgrades" label="Upgrades" icon={ArrowFatLineUp} />
		</nav>
	);
};
