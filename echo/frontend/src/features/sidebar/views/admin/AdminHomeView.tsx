import { ChartBar, CreditCard, Handshake } from "@phosphor-icons/react";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const AdminHomeView = () => {
	return (
		<nav className="flex flex-col gap-0.5 p-1.5">
			<BackButton to="/" label="Admin dashboard" center />
			<NavItem
				to="/admin/usage-and-billing"
				label="Usage and billing"
				icon={ChartBar}
			/>
			<NavItem to="/admin/payments" label="Payments" icon={CreditCard} />
			<NavItem to="/admin/partners" label="Partners" icon={Handshake} />
		</nav>
	);
};
