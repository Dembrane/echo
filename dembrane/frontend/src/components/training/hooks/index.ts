import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

// ── Types ────────────────────────────────────────────────────────────────

export interface CatalogProduct {
	type: "online" | "in_person" | "flex";
	name: string;
	price_eur: number;
	included_participants: number;
	extra_price_eur: number | null;
	level: string;
	format: string;
	grants_license: boolean;
	coming_soon: boolean;
}

export interface RosterEntry {
	app_user_id: string;
	display_name: string;
	email: string | null;
	role: string;
	trained: boolean;
	trained_until: string | null;
	expiring_soon: boolean;
}

export interface OrgRoster {
	org_id: string;
	trained_count: number;
	total_count: number;
	can_manage: boolean;
	members: RosterEntry[];
}

export interface RequestTrainingPayload {
	type: "online" | "in_person";
	extra_participants?: number;
	notes?: string;
}

export interface RequestTrainingResult {
	training_id: string;
	status: string;
	type: string;
	base_price_eur: number;
	extra_price_eur: number | null;
	estimated_total_eur: number;
}

export interface MyLicense {
	id: string;
	org_id: string | null;
	training_id: string | null;
	completed_at: string | null;
	expires_at: string | null;
	status: string;
	active: boolean;
}

// ── Query keys ──────────────────────────────────────────────────────────

const catalogKey = () => ["v2", "training", "catalog"] as const;
const rosterKey = (orgId: string) =>
	["v2", "training", "orgs", orgId, "roster"] as const;
const myLicensesKey = () => ["v2", "training", "licenses", "me"] as const;

// ── Fetchers ──────────────────────────────────────────────────────────────

async function fetchCatalog(): Promise<CatalogProduct[]> {
	const res = await fetch(`${API_BASE_URL}/v2/training/catalog`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(`catalog ${res.status}`);
	return res.json();
}

async function fetchRoster(orgId: string): Promise<OrgRoster | null> {
	const res = await fetch(`${API_BASE_URL}/v2/training/orgs/${orgId}/roster`, {
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		return null;
	}
	if (!res.ok) throw new Error(`roster ${res.status}`);
	return res.json();
}

async function fetchMyLicenses(): Promise<MyLicense[]> {
	const res = await fetch(`${API_BASE_URL}/v2/training/licenses/me`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(`licenses ${res.status}`);
	return res.json();
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export const useTrainingCatalog = () =>
	useQuery({
		queryFn: fetchCatalog,
		queryKey: catalogKey(),
		staleTime: 5 * 60_000,
	});

export const useOrgTrainingRoster = (orgId?: string) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () => fetchRoster(orgId as string),
		queryKey: rosterKey(orgId ?? ""),
		retry: false,
		staleTime: 30_000,
	});

export const useMyLicenses = () =>
	useQuery({
		queryFn: fetchMyLicenses,
		queryKey: myLicensesKey(),
		staleTime: 30_000,
	});

export const useRequestTraining = (orgId?: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (
			payload: RequestTrainingPayload,
		): Promise<RequestTrainingResult> => {
			if (!orgId) throw new Error("No organisation");
			const res = await fetch(
				`${API_BASE_URL}/v2/training/orgs/${orgId}/request`,
				{
					body: JSON.stringify(payload),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: `Couldn't request training (${res.status})`,
				);
			}
			return res.json();
		},
		onError: (err: Error) => {
			toast.error(err.message || t`Couldn't request training`);
		},
		onSuccess: (_result, variables) => {
			// Funnel pair: training_request_started -> training_request_submitted.
			posthog.capture("training_request_submitted", {
				extra_participants: variables.extra_participants ?? 0,
				training_type: variables.type,
			});
			toast.success(t`Training requested. We'll be in touch to schedule it.`);
			if (orgId) {
				queryClient.invalidateQueries({ queryKey: rosterKey(orgId) });
			}
		},
	});
};
