import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AppWindowIcon, FolderIcon, GearIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";

interface OrgWorkspaceRow {
	id: string;
	name: string;
}

async function fetchOrgWorkspaces(
	orgId: string,
): Promise<OrgWorkspaceRow[] | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/workspaces`, {
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) {
		throw new Error(`workspaces ${res.status}`);
	}
	return (await res.json()) as OrgWorkspaceRow[];
}

export const OrgHomeView = () => {
	const { orgId: routeOrgId, organisationId } = useParams<{
		orgId?: string;
		organisationId?: string;
	}>();
	const orgId = routeOrgId ?? organisationId;
	const { workspaces: myWorkspaces } = useWorkspace();

	const myOrgWorkspaces = useMemo(
		() => myWorkspaces.filter((w) => w.org_id === orgId),
		[myWorkspaces, orgId],
	);

	const orgWsQuery = useQuery({
		enabled: Boolean(orgId),
		queryFn: async () => fetchOrgWorkspaces(orgId as string),
		// Shared namespace with OrganisationRoute; mutations affecting org workspaces must invalidate THIS key (not `["v2", "orgs", ...]`).
		queryKey: ["v2", "organisation", orgId, "workspaces"],
		retry: false,
		staleTime: 30_000,
	});

	const isExternal =
		orgWsQuery.data === null ||
		(myOrgWorkspaces.length > 0 &&
			myOrgWorkspaces.every((w) => w.role === "external"));

	const orgName = myOrgWorkspaces[0]?.org_name ?? t`Organisation`;

	const displayList = useMemo(() => {
		if (isExternal) {
			return myOrgWorkspaces.map((w) => ({
				id: w.id,
				isExternal: true,
				name: w.name,
			}));
		}
		const externalSet = new Set(
			myOrgWorkspaces.filter((w) => w.role === "external").map((w) => w.id),
		);
		const full = orgWsQuery.data;
		if (full && full.length > 0) {
			return full.map((w) => ({
				id: w.id,
				isExternal: externalSet.has(w.id),
				name: w.name,
			}));
		}
		return myOrgWorkspaces.map((w) => ({
			id: w.id,
			isExternal: w.role === "external",
			name: w.name,
		}));
	}, [isExternal, myOrgWorkspaces, orgWsQuery.data]);

	// Org-only members get no children under the org node; /w handles discovery instead.
	const hasDirectMembership = myOrgWorkspaces.length > 0;

	if (!orgId) return null;
	const base = `/o/${orgId}`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to="/w" label={<Trans>Home</Trans>} />

			<div
				className="px-2 pb-1 pt-2 text-[13px] leading-tight"
				style={{ color: "#2d2d2c" }}
			>
				<div className="truncate">{orgName}</div>
			</div>

			{!isExternal && (
				<NavItem
					to={`${base}/overview`}
					label={<Trans>Overview</Trans>}
					icon={AppWindowIcon}
					end
				/>
			)}

			{hasDirectMembership && (
				<>
					<SectionLabel>
						<Trans>Workspaces</Trans>
					</SectionLabel>
					{displayList.map((ws) => (
						<NavItem
							key={ws.id}
							to={`/w/${ws.id}/home`}
							label={ws.name}
							icon={FolderIcon}
							badge={ws.isExternal ? <Trans>External</Trans> : undefined}
							pushes
						/>
					))}
				</>
			)}

			{!isExternal && (
				<>
					<div className="mt-auto" />
					<NavItem
						to={`${base}/settings/general`}
						label={<Trans>Settings</Trans>}
						icon={GearIcon}
						pushes
					/>
				</>
			)}
		</nav>
	);
};
