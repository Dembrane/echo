import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Container,
	Group,
	Image,
	Loader,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router";
import {
	Buildings,
	ChatCircle,
	ChatsCircle,
	FileText,
	FolderOpen,
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
	org_id: string;
	org_name: string;
	org_logo_url: string | null;
	role: string;
}

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

function OrgRow({ org, onOpen }: { org: OrgListItem; onOpen: () => void }) {
	const logo = resolveLogoUrl(org.logo_url);
	return (
		<Paper
			p="md"
			radius="md"
			withBorder
			role="button"
			tabIndex={0}
			style={{ cursor: "pointer", transition: "box-shadow 0.15s ease" }}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.boxShadow = "0 2px 12px rgba(0,0,0,0.08)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.boxShadow = "";
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="md">
				<Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
					{logo && (
						<Image
							src={logo}
							alt={t`${org.name} logo`}
							h={32}
							w="auto"
							fit="contain"
							style={{ flexShrink: 0, maxWidth: 96 }}
						/>
					)}
					<Box style={{ minWidth: 0 }}>
						<Group gap={8} wrap="nowrap">
							<Text fw={500} size="md" lineClamp={1}>
								{org.name}
							</Text>
							{org.isExternal && (
								<Badge size="xs" variant="light" color="gray">
									<Trans>External</Trans>
								</Badge>
							)}
						</Group>
						{org.memberCount !== null && (
							<Text size="xs" c="dimmed">
								<Plural
									value={org.memberCount}
									one="# person"
									other="# people"
								/>
							</Text>
						)}
					</Box>
				</Group>
				<IconChevronRight
					size={16}
					style={{ color: "var(--mantine-color-gray-5)", flexShrink: 0 }}
				/>
			</Group>
		</Paper>
	);
}

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
				subtitle: "Organisation",
			});
		}
		for (const ws of workspaces) {
			all.push({
				href: `/w/${ws.id}/home`,
				icon: FolderOpen,
				id: `ws-${ws.id}`,
				label: ws.name,
				subtitle: `${ws.org_name} · Workspace`,
			});
		}
		// Settings as quick shortcuts
		const settings = [
			{ href: "/settings/account", label: "Account & security" },
			{ href: "/settings/access", label: "My access" },
			{ href: "/settings/appearance", label: "Appearance" },
		];
		for (const s of settings) {
			all.push({
				href: s.href,
				icon: Gear,
				id: `setting-${s.href}`,
				label: s.label,
				subtitle: "Settings",
			});
		}

		if (!query) {
			// No query → show recents (translated to Hits) then everything
			const recentHits: Hit[] = recents.map((r) => ({
				href: r.href,
				icon: FolderOpen,
				id: `recent-${r.kind}-${r.id}`,
				label: r.label,
				subtitle: r.parent ?? (r.kind === "project" ? "Project" : "Workspace"),
			}));
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
			push({
				href: `/w/${p.workspaceId}/projects/${p.id}/home`,
				icon: FolderOpen,
				id: `proj-${p.id}`,
				label: p.name ?? "Project",
				subtitle: "Project",
			});
		}
		for (const c of deep.conversations) {
			if (!c.workspaceId || !c.projectId) continue;
			push({
				href: `/w/${c.workspaceId}/projects/${c.projectId}/conversation/${c.id}`,
				icon: ChatCircle,
				id: `conv-${c.id}`,
				label: c.displayLabel,
				subtitle: c.projectName
					? `${c.projectName} · Conversation`
					: "Conversation",
			});
		}
		for (const t of deep.transcripts) {
			if (!t.workspaceId || !t.projectId || !t.conversationId) continue;
			push({
				href: `/w/${t.workspaceId}/projects/${t.projectId}/conversation/${t.conversationId}`,
				icon: FileText,
				id: `chunk-${t.id}`,
				label: t.conversationLabel ?? "Transcript",
				subtitle: t.excerpt ? t.excerpt.slice(0, 80) : "Transcript",
			});
		}
		for (const ch of deep.chats) {
			if (!ch.workspaceId || !ch.projectId) continue;
			push({
				href: `/w/${ch.workspaceId}/projects/${ch.projectId}/chats/${ch.id}`,
				icon: ChatsCircle,
				id: `chat-${ch.id}`,
				label: ch.name ?? "Chat",
				subtitle: ch.projectName ? `${ch.projectName} · Chat` : "Chat",
			});
		}

		return merged.slice(0, 40);
	}, [q, workspaces, recents, deepSearch.data]);

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
		<div style={{ display: "flex", flexDirection: "column", width: "100%", position: "relative" }}>
			{orgList.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 1229, paddingTop: 163 }}>
					{/* Component 4: Text */}
					<div
						style={{
							marginLeft: 309,
							width: "55.3%",
							height: 102,
							display: "flex",
							flexDirection: "column",
							justifyContent: "center",
						}}
					>
						<Title order={1} style={{ fontSize: 36, fontWeight: 500, lineHeight: 1.2, color: "#2d2d2c" }}>
							{firstName ? <Trans>hi {firstName}</Trans> : <Trans>hi</Trans>}
						</Title>
						<Text size="md" c="dimmed" style={{ marginTop: 8 }}>
							<Trans>Where would you like to go</Trans>
						</Text>
					</div>

					{/* Component 5: Search */}
					<div
						style={{
							marginLeft: 309,
							width: "55.1%",
							height: 76,
							marginTop: 32,
							borderRadius: 12,
							border: "1px solid rgba(45, 45, 44, 0.12)",
							backgroundColor: "#fff",
							display: "flex",
							alignItems: "center",
							padding: "0 20px",
							boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
							transition: "border-color 0.15s ease, box-shadow 0.15s ease",
						}}
					>
						<MagnifyingGlass size={24} style={{ color: "rgba(45, 45, 44, 0.4)", marginRight: 14 }} />
						<TextInput
							value={q}
							onChange={(e) => {
								setQ(e.currentTarget.value);
								setActiveIndex(0);
							}}
							onKeyDown={onKeyDown}
							placeholder={t`Search projects, organisations, workspaces, settings…`}
							variant="unstyled"
							styles={{
								root: { flex: 1 },
								input: {
									fontSize: 18,
									height: 56,
									color: "#2d2d2c",
									"&::placeholder": {
										color: "rgba(45, 45, 44, 0.35)",
									},
								},
							}}
							autoFocus
						/>
					</div>

					{/* Component 6: List */}
					<div
						style={{
							marginLeft: 312,
							width: "53.5%",
							maxHeight: 377,
							marginTop: 6,
							overflowY: "auto",
							display: "flex",
							flexDirection: "column",
							gap: 4,
							padding: 4,
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
											gap: 12,
											borderRadius: 8,
											padding: "10px 14px",
											textAlign: "left",
											fontSize: 14,
											border: "none",
											cursor: "pointer",
											backgroundColor: active
												? "rgba(65, 105, 225, 0.08)"
												: "transparent",
											color: active ? "#4169e1" : "#2d2d2c",
											transition: "background-color 0.1s ease, color 0.1s ease",
										}}
									>
										<Icon size={18} style={{ opacity: active ? 1 : 0.7 }} />
										<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
											{hit.label}
										</span>
										{hit.subtitle && (
											<span
												style={{
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
													fontSize: 11,
													color: active ? "#4169e1" : "rgba(45, 45, 44, 0.5)",
													opacity: active ? 0.8 : 1,
												}}
											>
												{hit.subtitle}
											</span>
										)}
									</button>
								);
							})
						)}
					</div>
				</div>
			) : invites.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 1229, paddingTop: 163 }}>
					<Stack align="center" gap={12} mt="10vh">
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
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 1229, paddingTop: 163 }}>
					<Stack align="center" gap={8} mt="10vh">
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
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 1229, paddingTop: 163 }}>
					<Stack align="center" gap={8} mt="10vh">
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
