import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	CloseButton,
	Container,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Navigate } from "react-router";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { API_BASE_URL } from "@/config";
import {
	type SearchHit,
	useSearchHits,
} from "@/features/sidebar/hooks/useSearchHits";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMyInvites } from "@/hooks/useMyInvites";
import { useV2Me } from "@/hooks/useV2Me";
import classes from "./WorkspaceSelectorRoute.module.css";

// Full-page search over the orgs, workspaces, projects and settings the user
// can reach. Rich workspace cards live a level down at the org overview.

// Centered frame shared by every state on this page.
const FRAME_MAX_WIDTH = 580;
const FRAME_TOP_MARGIN = "20vh";

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

const CenteredLoader = () => (
	<Container size="sm" py="xl">
		<Stack align="center" gap={16} mt={FRAME_TOP_MARGIN}>
			<Loader size="sm" color="gray" />
		</Stack>
	</Container>
);

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
		return <CenteredLoader />;
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
	// Keyboard highlight: first result while searching, -1 (none) when empty.
	const [activeIndex, setActiveIndex] = useState(-1);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const { data, isLoading, isError, refetch } = useQuery({
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces"],
		staleTime: 30_000,
	});

	// Logged-in user, for the greeting.
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
	const orgList = useMemo(
		() => deriveOrgList(organisations, workspaces),
		[organisations, workspaces],
	);

	const { hits, isFetching } = useSearchHits(q, workspaces);

	const onSelect = (hit: SearchHit) => {
		navigate(hit.href);
	};

	const onClear = () => {
		setQ("");
		setActiveIndex(-1);
		searchInputRef.current?.focus();
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
		return <CenteredLoader />;
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

	let content: React.ReactNode;
	if (orgList.length > 0) {
		content = (
			<Box w="100%" maw={FRAME_MAX_WIDTH} mt={FRAME_TOP_MARGIN}>
				<Text aria-hidden mb={12} style={{ fontSize: 32 }}>
					🏠
				</Text>
				<Title
					order={1}
					style={{
						color: "var(--app-text)",
						fontSize: 36,
						fontWeight: 500,
						lineHeight: 1.2,
					}}
				>
					{firstName ? <Trans>Hi {firstName}</Trans> : <Trans>Hi</Trans>}
				</Title>
				<Text size="md" c="dimmed" mt={8}>
					<Trans>Where would you like to go?</Trans>
				</Text>

				<TextInput
					ref={searchInputRef}
					mt={32}
					size="lg"
					leftSection={<MagnifyingGlassIcon size={20} />}
					placeholder={t`Search projects, organisations, workspaces, settings…`}
					value={q}
					onChange={(e) => {
						const value = e.currentTarget.value;
						setQ(value);
						setActiveIndex(value ? 0 : -1);
					}}
					onKeyDown={onKeyDown}
					classNames={{ input: classes.searchInput }}
					autoFocus
					rightSectionPointerEvents="auto"
					rightSection={
						q ? (
							<CloseButton aria-label={t`Clear search`} onClick={onClear} />
						) : undefined
					}
					role="combobox"
					aria-expanded={hits.length > 0}
					aria-controls="search-results-list"
					aria-activedescendant={
						hits[activeIndex] ? `search-option-${activeIndex}` : undefined
					}
				/>

				<Stack
					id="search-results-list"
					role="listbox"
					aria-label={t`Search results`}
					gap={8}
					mt={16}
					py={4}
				>
					{hits.length === 0 ? (
						<Text ta="center" c="dimmed" py={24} fz={14}>
							{isFetching ? (
								<Trans>Searching…</Trans>
							) : (
								<Trans>No matches found</Trans>
							)}
						</Text>
					) : (
						hits.map((hit, i) => {
							const Icon = hit.icon;
							const active = i === activeIndex;
							return (
								<button
									type="button"
									key={hit.id}
									id={`search-option-${i}`}
									role="option"
									aria-selected={active}
									onClick={() => onSelect(hit)}
									className={
										active
											? `${classes.resultRow} ${classes.resultRowActive}`
											: classes.resultRow
									}
								>
									<Icon size={20} className={classes.resultIcon} />
									<span className={classes.resultLabel}>
										<span className={classes.resultTitle}>{hit.label}</span>
										{hit.subtitle ? (
											<span className={classes.resultSubtitle}>
												{hit.subtitle}
											</span>
										) : null}
									</span>
								</button>
							);
						})
					)}
				</Stack>
			</Box>
		);
	} else if (invites.length > 0) {
		content = (
			<Box w="100%" maw={FRAME_MAX_WIDTH} mt={FRAME_TOP_MARGIN}>
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
								{invites[0].workspace_name ?? "a workspace"}. The admin needs to
								free a seat before you can join.
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
			</Box>
		);
	} else if (recentRemovals.length > 0) {
		content = (
			<Box w="100%" maw={FRAME_MAX_WIDTH} mt={FRAME_TOP_MARGIN}>
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
			</Box>
		);
	} else {
		content = (
			<Box w="100%" maw={FRAME_MAX_WIDTH} mt={FRAME_TOP_MARGIN}>
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
			</Box>
		);
	}

	return (
		<Box
			w="100%"
			px={16}
			style={{
				alignItems: "center",
				display: "flex",
				flexDirection: "column",
				position: "relative",
			}}
		>
			{content}
		</Box>
	);
};
