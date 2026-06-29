import { Trans } from "@lingui/react/macro";
import { useDisclosure } from "@mantine/hooks";
import {
	Buildings,
	FolderOpen,
	Folders,
	House,
	Plus,
	ShieldStar,
	Sparkle,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { CreateOrganisationModal } from "@/components/organisation/CreateOrganisationModal";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isOutsiderRole } from "@/lib/roles";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";

export const UserHomeView = () => {
	const { workspaces, isLoading } = useWorkspace();
	const { data: meV2 } = useV2Me({ enabled: true });

	// Internal orgs come from org membership (meV2.orgs), NOT the workspace list.
	// A user invited to an org with no workspace yet still belongs to it and must
	// see it — that's how they reach workspace discovery (request access / join).
	// Deriving from `workspaces` (direct memberships only) hid org-only members.
	const internalOrgs = useMemo(
		() =>
			(meV2?.orgs ?? [])
				.map((o) => ({ id: o.id, name: o.name || "Untitled organisation" }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		[meV2],
	);
	const internalOrgIds = useMemo(
		() => new Set(internalOrgs.map((o) => o.id)),
		[internalOrgs],
	);
	// External orgs: outsiders (external/observer) have no org_membership, so
	// they're absent from meV2.orgs. Derive from workspaces.
	const externalOrgs = useMemo(() => {
		const map = new Map<string, { id: string; name: string }>();
		for (const ws of workspaces) {
			if (!ws.org_id || !isOutsiderRole(ws.role)) continue;
			if (internalOrgIds.has(ws.org_id) || map.has(ws.org_id)) continue;
			map.set(ws.org_id, {
				id: ws.org_id,
				name: ws.org_name || "Untitled organisation",
			});
		}
		return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [workspaces, internalOrgIds]);

	// Owns no organisation of their own (org_membership). External-only users
	// have workspaces (as external) but no owned org — they can always spin up
	// their own org (ISSUE-028). meV2.orgs is the owned-org list.
	const ownsNoOrg = (meV2?.orgs?.length ?? 0) === 0;
	// "Brand new" empty state = no org membership AND no workspaces. Gated on
	// meV2 being loaded so an org-only member never flashes this. They must see
	// their org links instead.
	const showFirstOrgSetup =
		!isLoading && meV2 != null && ownsNoOrg && workspaces.length === 0;
	const [createOrgOpened, createOrgHandlers] = useDisclosure(false);
	const isStaff = meV2?.is_staff === true;
	const needsOnboarding = meV2?.onboarding_completed === false;
	const workspacesWithoutOrg = useMemo(
		() => workspaces.filter((w) => !w.org_id),
		[workspaces],
	);

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			{needsOnboarding && (
				<NavItem to="/onboarding" label={<Trans>Setup</Trans>} icon={Sparkle} />
			)}
			<NavItem to="/o" label={<Trans>Home</Trans>} icon={House} end />

			{showFirstOrgSetup ? (
				<>
					<SectionLabel>
						<Trans>Get started</Trans>
					</SectionLabel>
					<NavItem
						to="/onboarding"
						label={<Trans>Set up your first organisation</Trans>}
						icon={Sparkle}
					/>
				</>
			) : (
				<>
					{internalOrgs.length > 0 && (
						<>
							<SectionLabel>
								<Trans>Organisations</Trans>
							</SectionLabel>
							{internalOrgs.map((org) => (
								<NavItem
									key={org.id}
									to={`/o/${org.id}/overview`}
									label={org.name}
									icon={Buildings}
									pushes
								/>
							))}
						</>
					)}
					{externalOrgs.map((org) => (
						<NavItem
							key={org.id}
							to={`/o/${org.id}/overview`}
							label={org.name}
							icon={Buildings}
							badge={<Trans>External</Trans>}
							pushes
						/>
					))}
					{ownsNoOrg && (
						<button
							type="button"
							onClick={createOrgHandlers.open}
							className="relative flex h-[30px] items-center gap-2 rounded-md px-2 text-sm leading-tight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
							style={{ color: "#4169e1" }}
							data-testid="sidebar-create-org"
						>
							<Plus size={16} />
							<span className="truncate">
								<Trans>Set up your organisation</Trans>
							</span>
						</button>
					)}
					{workspacesWithoutOrg.map((workspace) => (
						<NavItem
							key={workspace.id}
							to={`/w/${workspace.id}/home`}
							label={workspace.name}
							icon={Folders}
							pushes
						/>
					))}
					{isStaff && (
						<NavItem
							to="/admin"
							label={<Trans>Admin dashboard</Trans>}
							icon={ShieldStar}
							accent="#7e22ce"
							pushes
						/>
					)}
				</>
			)}
			<CreateOrganisationModal
				opened={createOrgOpened}
				onClose={createOrgHandlers.close}
			/>
		</nav>
	);
};
