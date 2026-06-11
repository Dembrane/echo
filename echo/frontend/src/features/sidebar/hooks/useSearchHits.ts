import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useDebouncedValue } from "@mantine/hooks";
import {
	BuildingsIcon,
	ChatCircleIcon,
	ChatsCircleIcon,
	FileTextIcon,
	FolderOpenIcon,
	FoldersIcon,
	GearIcon,
	type Icon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { useRecents } from "./useRecents";

// Shared search-hit builder for the command palette (SearchBlock) and the
// organisations home page (WorkspaceSelectorRoute), which show the same results.

// Both WorkspaceLite (/v2/workspaces) and WorkspaceSummary satisfy this
// structurally, so either source can feed the hook.
export interface SearchWorkspace {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
}

export interface SearchHit {
	id: string;
	icon: Icon;
	label: string;
	subtitle?: string;
	href: string;
}

// GET /api/home/search — deep search over projects, conversations,
// transcripts and chats, access-scoped server-side.
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

const MAX_HITS = 40;
const EXCERPT_LENGTH = 60;

// Settings shortcuts surfaced in search. Labels are translated at build time.
const SETTINGS_LINKS: { href: string; label: () => string }[] = [
	{ href: "/settings/account", label: () => t`Account & security` },
	{ href: "/settings/access", label: () => t`My access` },
	{ href: "/settings/appearance", label: () => t`Appearance` },
];

export function useSearchHits(
	query: string,
	workspaces: SearchWorkspace[],
	options: { enabled?: boolean } = {},
): { hits: SearchHit[]; isFetching: boolean } {
	const { enabled = true } = options;
	const { i18n } = useLingui();
	const { items: recents } = useRecents();
	const { data: me } = useV2Me();

	const [debouncedQ] = useDebouncedValue(query.trim(), 250);
	const deepSearch = useQuery({
		enabled: enabled && debouncedQ.length >= 2,
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: `t` macro reads the active locale, so labels must recompute on language switch.
	const hits = useMemo<SearchHit[]>(() => {
		const needle = query.trim().toLowerCase();
		// O(1) workspace lookups for the deep-result loops below.
		const wsById = new Map(workspaces.map((w) => [w.id, w]));

		const orgs = new Map<string, { name: string }>();
		for (const ws of workspaces) {
			if (ws.org_id && !orgs.has(ws.org_id)) {
				orgs.set(ws.org_id, { name: ws.org_name || "" });
			}
		}

		const all: SearchHit[] = [];
		for (const [id, o] of orgs) {
			all.push({
				href: `/o/${id}/overview`,
				icon: BuildingsIcon,
				id: `org-${id}`,
				label: o.name,
				subtitle: `${t`Organisation`} / ${o.name}`,
			});
		}
		for (const ws of workspaces) {
			all.push({
				href: `/w/${ws.id}/home`,
				icon: FoldersIcon,
				id: `ws-${ws.id}`,
				label: ws.name,
				subtitle: `${ws.org_name} / ${ws.name}`,
			});
		}
		const userName = me?.display_name || t`Account`;
		for (const s of SETTINGS_LINKS) {
			const label = s.label();
			all.push({
				href: s.href,
				icon: GearIcon,
				id: `setting-${s.href}`,
				label,
				subtitle: `${userName} / ${label}`,
			});
		}

		if (!needle) {
			// No query → show recents (translated to hits) then everything.
			const recentHits: SearchHit[] = recents.map((r) => {
				const match = r.href.match(/\/w\/([^/]+)/);
				const ws = match ? wsById.get(match[1]) : undefined;
				let subtitle =
					r.parent ?? (r.kind === "project" ? t`Project` : t`Workspace`);
				if (ws) {
					subtitle =
						r.kind === "project"
							? `${ws.org_name} / ${ws.name} / ${r.label}`
							: `${ws.org_name} / ${ws.name}`;
				}
				return {
					href: r.href,
					icon: r.kind === "project" ? FolderOpenIcon : FoldersIcon,
					id: `recent-${r.kind}-${r.id}`,
					label: r.label,
					subtitle,
				};
			});
			const seen = new Set(recentHits.map((h) => h.label.toLowerCase()));
			const rest = all.filter((h) => !seen.has(h.label.toLowerCase()));
			return [...recentHits, ...rest].slice(0, MAX_HITS);
		}

		const clientHits = all.filter((h) => {
			const hay = `${h.label} ${h.subtitle ?? ""}`.toLowerCase();
			return hay.includes(needle);
		});

		// Deep results from /home/search, deduped by destination so the same
		// page never shows twice (e.g. a recents row + a project hit, or a
		// conversation hit + its own transcript hit).
		const merged: SearchHit[] = [...clientHits];
		const seenHrefs = new Set(clientHits.map((h) => h.href));
		const push = (hit: SearchHit) => {
			if (seenHrefs.has(hit.href)) return;
			seenHrefs.add(hit.href);
			merged.push(hit);
		};

		const deep = deepSearch.data ?? EMPTY_SEARCH;
		for (const p of deep.projects) {
			if (!p.workspaceId) continue;
			const ws = wsById.get(p.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${p.name ?? t`Project`}`
				: t`Project`;
			push({
				href: `/w/${p.workspaceId}/projects/${p.id}/home`,
				icon: FolderOpenIcon,
				id: `proj-${p.id}`,
				label: p.name ?? t`Project`,
				subtitle,
			});
		}
		for (const c of deep.conversations) {
			if (!c.workspaceId || !c.projectId) continue;
			const ws = wsById.get(c.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${c.projectName || t`Project`} / ${c.displayLabel}`
				: c.projectName
					? `${c.projectName} / ${c.displayLabel}`
					: t`Conversation`;
			push({
				href: `/w/${c.workspaceId}/projects/${c.projectId}/conversation/${c.id}`,
				icon: ChatCircleIcon,
				id: `conv-${c.id}`,
				label: c.displayLabel,
				subtitle,
			});
		}
		for (const tr of deep.transcripts) {
			if (!tr.workspaceId || !tr.projectId || !tr.conversationId) continue;
			const ws = wsById.get(tr.workspaceId);
			const path = ws
				? `${ws.org_name} / ${ws.name} / ${tr.conversationLabel ?? t`Transcript`}`
				: t`Transcript`;
			const subtitle = tr.excerpt
				? `${path}: "${tr.excerpt.slice(0, EXCERPT_LENGTH)}..."`
				: path;
			push({
				href: `/w/${tr.workspaceId}/projects/${tr.projectId}/conversation/${tr.conversationId}`,
				icon: FileTextIcon,
				id: `chunk-${tr.id}`,
				label: tr.conversationLabel ?? t`Transcript`,
				subtitle,
			});
		}
		for (const ch of deep.chats) {
			if (!ch.workspaceId || !ch.projectId) continue;
			const ws = wsById.get(ch.workspaceId);
			const subtitle = ws
				? `${ws.org_name} / ${ws.name} / ${ch.projectName || t`Project`} / ${ch.name ?? t`Chat`}`
				: ch.projectName
					? `${ch.projectName} / ${ch.name ?? t`Chat`}`
					: t`Chat`;
			push({
				href: `/w/${ch.workspaceId}/projects/${ch.projectId}/chats/${ch.id}`,
				icon: ChatsCircleIcon,
				id: `chat-${ch.id}`,
				label: ch.name ?? t`Chat`,
				subtitle,
			});
		}

		return merged.slice(0, MAX_HITS);
	}, [query, workspaces, recents, deepSearch.data, me, i18n.locale]);

	return { hits, isFetching: deepSearch.isFetching };
}
