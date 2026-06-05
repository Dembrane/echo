import { Trans } from "@lingui/react/macro";
import {
	Buildings,
	FolderOpen,
	House,
	ShieldStar,
	Sparkle,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";

interface OrgGroup {
	id: string;
	name: string;
	workspaceCount: number;
	isExternal: boolean;
}

function groupByOrg(
	workspaces: ReturnType<typeof useWorkspace>["workspaces"],
): OrgGroup[] {
	const map = new Map<string, OrgGroup>();
	for (const ws of workspaces) {
		if (!ws.org_id) continue;
		const isExternal = ws.role === "external";
		const existing = map.get(ws.org_id);
		if (existing) {
			existing.workspaceCount += 1;
			if (!isExternal) existing.isExternal = false;
		} else {
			map.set(ws.org_id, {
				id: ws.org_id,
				isExternal,
				name: ws.org_name || "Untitled organisation",
				workspaceCount: 1,
			});
		}
	}
	return [...map.values()].sort((a, b) => {
		if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
}

export const UserHomeView = () => {
	const { workspaces, isLoading } = useWorkspace();
	const { data: meV2 } = useV2Me({ enabled: true });
	const orgs = useMemo(() => groupByOrg(workspaces), [workspaces]);
	const internalOrgs = useMemo(
		() => orgs.filter((org) => !org.isExternal),
		[orgs],
	);
	const externalOrgs = useMemo(
		() => orgs.filter((org) => org.isExternal),
		[orgs],
	);
	const noWorkspaces = !isLoading && workspaces.length === 0;
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
			<NavItem to="/w" label={<Trans>Home</Trans>} icon={House} end />

			{noWorkspaces ? (
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
					{workspacesWithoutOrg.map((workspace) => (
						<NavItem
							key={workspace.id}
							to={`/w/${workspace.id}/home`}
							label={workspace.name}
							icon={FolderOpen}
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
		</nav>
	);
};
