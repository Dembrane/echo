import { Trans } from "@lingui/react/macro";
import { ChartLine, CreditCard, Gear, Users } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const OrgSettingsView = () => {
	const { orgId: routeOrgId, organisationId } = useParams<{
		orgId?: string;
		organisationId?: string;
	}>();
	const orgId = routeOrgId ?? organisationId;
	if (!orgId) return null;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to={`/o/${orgId}/overview`} label={<Trans>Settings</Trans>} center />
			<NavItem
				to={`/o/${orgId}/settings/general`}
				label={<Trans>General</Trans>}
				icon={Gear}
			/>
			<NavItem
				to={`/o/${orgId}/settings/usage`}
				label={<Trans>Usage and tier</Trans>}
				icon={ChartLine}
			/>
			<NavItem
				to={`/o/${orgId}/settings/members`}
				label={<Trans>Members</Trans>}
				icon={Users}
			/>
			<NavItem
				to={`/o/${orgId}/settings/billing`}
				label={<Trans>Billing</Trans>}
				icon={CreditCard}
			/>
		</nav>
	);
};
