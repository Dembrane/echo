import { Trans } from "@lingui/react/macro";
import { ChartLineIcon, CreditCardIcon, GearIcon, UsersIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useV2Me } from "@/hooks/useV2Me";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const OrgSettingsView = () => {
	const { orgId: routeOrgId, organisationId } = useParams<{
		orgId?: string;
		organisationId?: string;
	}>();
	const orgId = routeOrgId ?? organisationId;
	const { data: me } = useV2Me();
	// Mirror OrganisationRoute's `canSeeFinancials`; others get bounced off
	// Usage/Billing to the Members panel, so don't offer those items.
	const role = me?.orgs.find((o) => o.id === orgId)?.role;
	const canSeeFinancials =
		role === "owner" || role === "admin" || role === "billing";
	if (!orgId) return null;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to={`/o/${orgId}/overview`} label={<Trans>Settings</Trans>} center />
			<NavItem
				to={`/o/${orgId}/settings/general`}
				label={<Trans>General</Trans>}
				icon={GearIcon}
			/>
			{canSeeFinancials && (
				<NavItem
					to={`/o/${orgId}/settings/usage`}
					label={<Trans>Usage and tier</Trans>}
					icon={ChartLineIcon}
				/>
			)}
			<NavItem
				to={`/o/${orgId}/settings/members`}
				label={<Trans>Members</Trans>}
				icon={UsersIcon}
			/>
			{canSeeFinancials && (
				<NavItem
					to={`/o/${orgId}/settings/billing`}
					label={<Trans>Billing</Trans>}
					icon={CreditCardIcon}
				/>
			)}
		</nav>
	);
};
