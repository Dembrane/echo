import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

// Staff training tools (ISSUE-020) — call the /v2/admin/trainings endpoints.
// Self-contained so this wires into ISSUE-022's `training` Tabs.Panel at
// integration without touching admin.py / AdminSettingsRoute internals.

export interface StaffTrainingRow {
	id: string;
	org_id: string | null;
	org_name: string | null;
	type: string;
	included_participants: number;
	extra_participants: number;
	base_price_eur: number | null;
	extra_price_eur: number | null;
	grants_license: boolean;
	scheduled_at: string | null;
	status: string;
	notes: string | null;
	created_at: string | null;
	updated_at: string | null;
	license_count: number;
}

const trainingsKey = (orgId?: string, status?: string) =>
	["v2", "admin", "trainings", { orgId, status }] as const;

async function fetchTrainings(
	orgId?: string,
	status?: string,
): Promise<StaffTrainingRow[]> {
	const params = new URLSearchParams();
	if (orgId) params.set("org_id", orgId);
	if (status) params.set("status", status);
	const query = params.toString();
	const res = await fetch(
		`${API_BASE_URL}/v2/admin/trainings${query ? `?${query}` : ""}`,
		{ credentials: "include" },
	);
	if (!res.ok) throw new Error(`trainings ${res.status}`);
	return res.json();
}

export const useStaffTrainings = (orgId?: string, status?: string) =>
	useQuery({
		queryFn: () => fetchTrainings(orgId, status),
		queryKey: trainingsKey(orgId, status),
		staleTime: 30_000,
	});

export interface CreateTrainingInput {
	org_id: string;
	type: "online" | "in_person" | "flex";
	extra_participants?: number;
	scheduled_at?: string;
	notes?: string;
	base_price_eur?: number;
}

export const useCreateTraining = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: CreateTrainingInput) => {
			const res = await fetch(`${API_BASE_URL}/v2/admin/trainings`, {
				body: JSON.stringify(input),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: "Couldn't create training",
				);
			}
			return res.json();
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			toast.success(t`Training created`);
			queryClient.invalidateQueries({ queryKey: ["v2", "admin", "trainings"] });
		},
	});
};

export const useCompleteTraining = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			trainingId,
			appUserIds,
			completedAt,
		}: {
			trainingId: string;
			appUserIds: string[];
			completedAt?: string;
		}) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/trainings/${trainingId}/complete`,
				{
					body: JSON.stringify({
						app_user_ids: appUserIds,
						completed_at: completedAt,
					}),
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
						: "Couldn't mark complete",
				);
			}
			return res.json();
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			toast.success(t`Licenses granted`);
			queryClient.invalidateQueries({ queryKey: ["v2", "admin", "trainings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "training"] });
		},
	});
};
