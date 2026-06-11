import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Container,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router";
import {
	Buildings,
	ChatCircle,
	ChatsCircle,
	FileText,
	FolderOpen,
	Folders,
	Gear,
	MagnifyingGlass,
} from "@phosphor-icons/react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { API_BASE_URL } from "@/config";
import { useRecents } from "@/features/sidebar/hooks/useRecents";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMyInvites } from "@/hooks/useMyInvites";
import { useV2Me } from "@/hooks/useV2Me";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";

// The home page is now a plain list of organisations the user belongs to.
// Rich workspace cards (members, stats, pinned projects) moved down a level to
// the org overview (/o/:id). No workspace cards, stats rollups, or widgets here.

interface OrganisationRollup {
	id: string;
	name: string;
	role: string;
	logo_url: string | null;
	total_members: number;
	workspace_count: number;
}

interface WorkspaceLite {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	org_logo_url: string | null;
	role: string;
}

interface Hit {
	id: string;
	icon: ComponentType<{ size: number; style?: any }>;
	label: string;
	subtitle?: string;
	href: string;
}

interface HomeSearchResponse {
	projects: {
		id: string;
		name: string | null;
		workspaceId: string | null;
	}[];
	conversations: {
		id: string;
		projectId: string | null;
		projectName: string | null;
		workspaceId: string | null;
		displayLabel: string;
	}[];
	transcripts: {
		id: string;
		conversationId: string | null;
		conversationLabel: string | null;
		projectId: string | null;
		workspaceId: string | null;
		excerpt: string | null;
	}[];
	chats: {
		id: string;
		projectId: string | null;
		projectName: string | null;
		workspaceId: string | null;
		name: string | null;
	}[];
}

const EMPTY_SEARCH: HomeSearchResponse = {
	chats: [],
	conversations: [],
	projects: [],
	transcripts: [],
};

interface RecentRemoval {
	workspace_id: string;
	workspace_name: string;
	org_name: string;
	ended_at: string;
}

async function fetchWorkspaces(): Promise<{
	workspaces: WorkspaceLite[];
	organisations: OrganisationRollup[];
	recent_removals: RecentRemoval[];
}> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	// Throw rather than [] — empty list is indistinguishable from "no access".
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	return res.json();
}

interface OrgListItem {
	id: string;
	name: string;
	logo_url: string | null;
	memberCount: number | null;
	isExternal: boolean;
}

// External orgs are derived from external workspaces: they aren't in the
// membership rollup but the user still needs a way into them.
function deriveOrgList(
	organisations: OrganisationRollup[],
	workspaces: WorkspaceLite[],
): OrgListItem[] {
	const internalOrgs: OrgListItem[] = organisations.map((o) => ({
		id: o.id,
		isExternal: false,
		logo_url: o.logo_url,
		memberCount: o.total_members,
		name: o.name,
	}));

	const internalOrgIds = new Set(internalOrgs.map((o) => o.id));
	const externalOrgMap = new Map<string, OrgListItem>();
	for (const w of workspaces) {
		if (w.role !== "external" || !w.org_id) continue;
		if (internalOrgIds.has(w.org_id)) continue;
		if (!externalOrgMap.has(w.org_id)) {
			externalOrgMap.set(w.org_id, {
				id: w.org_id,
				isExternal: true,
				logo_url: w.org_logo_url,
				memberCount: null,
				name: w.org_name || t`Organisation`,
			});
		}
	}

	return [...internalOrgs, ...externalOrgMap.values()].sort((a, b) => {
		if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
}

// Entry decision: single-org users go straight to their org overview, everyone
// else to the home list. Lives at the root (not inside /o) so the shortcut
// fires once on entry and doesn't bounce single-org users off /o on every visit.
export const RootRedirect = () => {
	const { data, isLoading, isError } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// On error fall through to the home list, which renders its own error panel.
	// Relative targets keep any active /:language prefix intact.
	if (isError || !data) {
		return <Navigate to="o" replace />;
	}

	const orgList = deriveOrgList(
		data.organisations ?? [],
		data.workspaces ?? [],
	);
	if (orgList.length === 1) {
		return <Navigate to={`o/${orgList[0].id}/overview`} replace />;
	}
	return <Navigate to="o" replace />;
};



export const WorkspaceSelectorRoute = () => {
	const navigate = useI18nNavigate();

	useDocumentTitle(t`Organisations | dembrane`);

	const [q, setQ] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const { items: recents } = useRecents();

	const { data, isLoading, isError, refetch } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	// Load logged-in user for greeting
	const { data: me } = useV2Me();

	// Pending invites for this user. Used by the empty state so a guest who got
	// bounced at the cap (or hasn't accepted yet) doesn't see the "no access"
	// copy that they can't act on.
	const { data: pendingInvites } = useMyInvites();

	const organisations = data?.organisations ?? [];
	const workspaces = data?.workspaces ?? [];
	const recentRemovals = data?.recent_removals ?? [];
	const invites = pendingInvites ?? [];

	// No single-org redirect here (it's in RootRedirect), so this list stays
	// reachable for single-org users.
	const orgList = deriveOrgList(organisations, workspaces);

	const [debouncedQ] = useDebouncedValue(q.trim(), 250);
	const deepSearch = useQuery({
		enabled: debouncedQ.length >= 2,
		queryFn: async (): Promise<HomeSearchResponse> => {
			const res = await fetch(
				`${API_BASE_URL}/home/search?query=${encodeURIComponent(debouncedQ)}&limit=5`,
				{ credentials: "include" },
			);
			if (!res.ok) return EMPTY_SEARCH;
			return res.json();
		},
		queryKey: ["home-search", debouncedQ],
		staleTime: 30_000,
	});

	const hits = useMemo<Hit[]>(() => {
		const query = q.trim().toLowerCase();
		const orgs = new Map<string, { name: string }>();
		for (const ws of workspaces) {
			if (ws.org_id && !orgs.has(ws.org_id)) {
				orgs.set(ws.org_id, { name: ws.org_name || "" });
			}
		}

		const all: Hit[] = [];
		for (const [id, o] of orgs) {
			all.push({
				href: `/o/${id}/overview`,
				icon: Buildings,
				id: `org-${id}`,
				label: o.name,
				subtitle: `Organisation / ${o.name}`,
			});
		}
		for (const ws of workspaces) {
			all.push({
				href: `/w/${ws.id}/home`,
				icon: Folders,
				id: `ws-${ws.id}`,
				label: ws.name,
				subtitle: `${ws.org_name} / ${ws.name}`,
			});
		}
		// Settings as quick shortcuts
		const settings = [
			{ href: "/settings/account", label: "Account & security" },
			{ href: "/settings/access", label: "My access" },
			{ href: "/settings/appearance", label: "Appearance" },
		];
		const userName = me?.display_name || "User";
		for (const s of settings) {
			all.push({
				href: s.href,
				icon: Gear,
				id: `setting-${s.href}`,
				label: s.label,
				subtitle: `${userName} / ${s.label}`,
			});
		}

		if (!query) {
			// No query → show recents (translated to Hits) then everything
			const recentHits: Hit[] = recents.map((r) => {
				const match = r.href.match(/\/w\/([^/]+)/);
				const wsId = match ? match[1] : null;
				const ws = workspaces.find((w) => w.id === wsId);
				let subtitle = r.parent ?? (r.kind === "project" ? "Project" : "Workspace");
				if (ws) {
					if (r.kind === "project") {
						subtitle = `${ws.org_name} / ${ws.name} / ${r.label}`;
					} else {
						subtitle = `${ws.org_name} / ${ws.name}`;
					}
				}
				return {
					href: r.href,
					icon: r.kind === "project" ? FolderOpen : Folders,
					id: `recent-${r.kind}-${r.id}`,
					label: r.label,
					subtitle,
				};
			});
			const seen = new Set(recentHits.map((h) => h.label.toLowerCase()));
			const rest = all.filter((h) => !seen.has(h.label.toLowerCase()));
			return [...recentHits, ...rest].slice(0, 40);
		}

		const clientHits = all.filter((h) => {
			const hay = `${h.label} ${h.subtitle ?? ""}`.toLowerCase();
			return hay.includes(query);
		});

		// Deep results from /home/search, deduped by destination so the
		// same page never shows twice
		const merged: Hit[] = [...clientHits];
		const seenHrefs = new Set(clientHits.map((h) => h.href));
		const push = (hit: Hit) => {
			if (seenHrefs.has(hit.href)) return;
			seenHrefs.add(hit.href);
			merged.push(hit);
		};

		const deep = deepSearch.data ?? EMPTY_SEARCH;
		for (const p of deep.projects) {
			if (!p.workspaceId) continue;
			const ws = workspaces.find((w) => w.id === p.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${p.name ?? "Project"}`
				: "Project";
			push({
				href: `/w/${p.workspaceId}/projects/${p.id}/home`,
				icon: FolderOpen,
				id: `proj-${p.id}`,
				label: p.name ?? "Project",
				subtitle,
			});
		}
		for (const c of deep.conversations) {
			if (!c.workspaceId || !c.projectId) continue;
			const ws = workspaces.find((w) => w.id === c.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${c.projectName || "Project"} / ${c.displayLabel}`
				: c.projectName
					? `${c.projectName} / ${c.displayLabel}`
					: "Conversation";
			push({
				href: `/w/${c.workspaceId}/projects/${c.projectId}/conversation/${c.id}`,
				icon: ChatCircle,
				id: `conv-${c.id}`,
				label: c.displayLabel,
				subtitle,
			});
		}
		for (const t of deep.transcripts) {
			if (!t.workspaceId || !t.projectId || !t.conversationId) continue;
			const ws = workspaces.find((w) => w.id === t.workspaceId);
			const path = ws
				? `${ws.org_name} / ${ws.name} / ${t.conversationLabel ?? "Transcript"}`
				: "Transcript";
			const subtitle = t.excerpt
				? `${path} — "${t.excerpt.slice(0, 60)}..."`
				: path;
			push({
				href: `/w/${t.workspaceId}/projects/${t.projectId}/conversation/${t.conversationId}`,
				icon: FileText,
				id: `chunk-${t.id}`,
				label: t.conversationLabel ?? "Transcript",
				subtitle,
			});
		}
		for (const ch of deep.chats) {
			if (!ch.workspaceId || !ch.projectId) continue;
			const ws = workspaces.find((w) => w.id === ch.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${ch.projectName || "Project"} / ${ch.name ?? "Chat"}`
				: ch.projectName
					? `${ch.projectName} / ${ch.name ?? "Chat"}`
					: "Chat";
			push({
				href: `/w/${ch.workspaceId}/projects/${ch.projectId}/chats/${ch.id}`,
				icon: ChatsCircle,
				id: `chat-${ch.id}`,
				label: ch.name ?? "Chat",
				subtitle,
			});
		}

		return merged.slice(0, 40);
	}, [q, workspaces, recents, deepSearch.data, me]);

	const onSelect = (hit: Hit) => {
		navigate(hit.href);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const hit = hits[activeIndex];
			if (hit) onSelect(hit);
		}
	};

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Distinct from the empty-state branch below — a 5xx is not "no access."
	if (isError) {
		return (
			<FetchErrorPanel
				onRetry={() => refetch()}
				message={
					<Trans>
						We couldn't load your organisations. Check your connection and try
						again.
					</Trans>
				}
			/>
		);
	}

	const firstName = me?.display_name ? me.display_name.split(" ")[0] : "";

	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", alignItems: "center", padding: "0 16px", position: "relative" }}>
			{orgList.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 580, marginTop: "20vh" }}>
					{/* Component 4: Text */}
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							justifyContent: "center",
							width: "100%",
						}}
					>
						<div style={{ fontSize: 32, marginBottom: 12 }}>🏠</div>
						<Title order={1} style={{ fontSize: 36, fontWeight: 500, lineHeight: 1.2, color: "#2d2d2c" }}>
							{firstName ? <Trans>Hi {firstName}</Trans> : <Trans>Hi</Trans>}
						</Title>
						<Text size="md" c="dimmed" style={{ marginTop: 8 }}>
							<Trans>Where would you like to go</Trans>
						</Text>
					</div>

					{/* Component 5: Search */}
					<div style={{ width: "100%", marginTop: 32 }}>
						<TextInput
							leftSection={<MagnifyingGlass size={20} style={{ color: "rgba(45, 45, 44, 0.4)" }} />}
							placeholder={t`Search projects, organisations, workspaces, settings…`}
							value={q}
							size="lg"
							onChange={(e) => {
								setQ(e.currentTarget.value);
								setActiveIndex(0);
							}}
							onKeyDown={onKeyDown}
							styles={{
								input: {
									fontSize: 16,
									borderRadius: 8,
									border: "1px solid rgba(45, 45, 44, 0.12)",
									height: 52,
									backgroundColor: "transparent",
									"&:focus": {
										borderColor: "#4169e1",
									},
								},
							}}
							autoFocus
						/>
					</div>

					{/* Component 6: List */}
					<div
						style={{
							width: "100%",
							marginTop: 16,
							display: "flex",
							flexDirection: "column",
							gap: 8,
							padding: "4px 0",
						}}
					>
						{hits.length === 0 ? (
							<div
								style={{
									padding: "24px 0",
									textAlign: "center",
									fontSize: 14,
									color: "rgba(45, 45, 44, 0.5)",
								}}
							>
								{deepSearch.isFetching ? (
									<Trans>Searching…</Trans>
								) : (
									<Trans>No matches found</Trans>
								)}
							</div>
						) : (
							hits.map((hit, i) => {
								const Icon = hit.icon;
								const active = i === activeIndex;
								return (
									<button
										type="button"
										key={hit.id}
										onClick={() => onSelect(hit)}
										onMouseEnter={() => setActiveIndex(i)}
										style={{
											display: "flex",
											width: "100%",
											alignItems: "center",
											gap: 16,
											borderRadius: 4,
											padding: "16px 20px",
											textAlign: "left",
											fontSize: 14,
											cursor: "pointer",
											border: active
												? "1px solid #4169e1"
												: "1px solid rgba(45, 45, 44, 0.12)",
											backgroundColor: active
												? "rgba(65, 105, 225, 0.04)"
												: "transparent",
											color: "#2d2d2c",
											transition: "border-color 0.15s ease, background-color 0.15s ease",
											boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
										}}
									>
										<Icon size={20} style={{ color: active ? "#4169e1" : "rgba(45, 45, 44, 0.6)", flexShrink: 0 }} />
										<div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
											<span style={{ fontSize: 16, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
												{hit.label}
											</span>
											{hit.subtitle && (
												<span
													style={{
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
														fontSize: 12,
														color: active ? "#4169e1" : "rgba(45, 45, 44, 0.5)",
														opacity: active ? 0.9 : 1,
														marginTop: 2,
													}}
												>
													{hit.subtitle}
												</span>
											)}
										</div>
									</button>
								);
							})
						)}
					</div>
				</div>
			) : invites.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 580, marginTop: "20vh" }}>
					<Stack align="center" gap={12}>
						<Text c="dimmed" size="sm" ta="center">
							{invites[0].type === "org" ? (
								<Trans>
									You have a pending invite to {invites[0].org_name}. Open it to
									join the organisation.
								</Trans>
							) : (
								<Trans>
									You have a pending invite to{" "}
									{invites[0].workspace_name ?? "a workspace"}. The admin needs
									to free a seat before you can join.
								</Trans>
							)}
						</Text>
						<Button
							variant="outline"
							size="sm"
							onClick={() => navigate("/invites")}
						>
							<Trans>View invite</Trans>
						</Button>
					</Stack>
				</div>
			) : recentRemovals.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 580, marginTop: "20vh" }}>
					<Stack align="center" gap={8}>
						<Text c="dimmed" size="sm" ta="center">
							<Trans>
								Your access to {recentRemovals[0].workspace_name} ended on{" "}
								{new Date(recentRemovals[0].ended_at).toLocaleDateString()}.
							</Trans>
						</Text>
						<Text c="dimmed" size="xs" ta="center">
							<Trans>Contact the admin if this was unexpected.</Trans>
						</Text>
					</Stack>
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 580, marginTop: "20vh" }}>
					<Stack align="center" gap={8}>
						<Text c="dimmed" size="sm" ta="center">
							<Trans>You're not part of any organisation right now.</Trans>
						</Text>
						<Text c="dimmed" size="sm" ta="center">
							<Trans>
								If you were expecting access, please ask the person who invited
								you to send it again.
							</Trans>
						</Text>
					</Stack>
				</div>
			)}
		</div>
	);
};
