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
	requested_by: string | null;
	requested_by_name: string | null;
	requested_by_email: string | null;
	created_at: string | null;
	updated_at: string | null;
	license_count: number;
	org_member_count: number;
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

export const useStaffTrainings = () =>
	useQuery({
		queryFn: () => fetchTrainings(),
		queryKey: trainingsKey(),
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

export interface UpdateTrainingInput {
	trainingId: string;
	status?: "requested" | "scheduled" | "completed" | "cancelled";
	scheduledAt?: string;
}

export const useUpdateTraining = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			trainingId,
			status,
			scheduledAt,
		}: UpdateTrainingInput) => {
			const body: Record<string, unknown> = {};
			if (status !== undefined) body.status = status;
			if (scheduledAt !== undefined) body.scheduled_at = scheduledAt;
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/trainings/${trainingId}`,
				{
					body: JSON.stringify(body),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: "Couldn't update training",
				);
			}
			return res.json();
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			toast.success(t`Training updated`);
			queryClient.invalidateQueries({ queryKey: ["v2", "admin", "trainings"] });
		},
	});
};

export interface StaffRosterMember {
	app_user_id: string;
	display_name: string;
	email: string | null;
	role: string;
	trained: boolean;
	trained_until: string | null;
	expiring_soon: boolean;
}

export interface StaffOrgRoster {
	org_id: string;
	trained_count: number;
	total_count: number;
	members: StaffRosterMember[];
}

export const useStaffOrgRoster = (orgId: string | null, enabled: boolean) =>
	useQuery({
		queryFn: async (): Promise<StaffOrgRoster> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/trainings/orgs/${orgId}/roster`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`roster ${res.status}`);
			return res.json();
		},
		queryKey: ["v2", "admin", "trainings", "roster", orgId] as const,
		enabled: enabled && !!orgId,
		staleTime: 30_000,
	});

export interface TrainingLicense {
	id: string;
	app_user_id: string;
	app_user_name: string | null;
	app_user_email: string | null;
	status: string;
	completed_at: string | null;
	expires_at: string | null;
}

export const useTrainingLicenses = (trainingId: string, enabled: boolean) =>
	useQuery({
		queryFn: async (): Promise<TrainingLicense[]> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/trainings/${trainingId}/licenses`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`licenses ${res.status}`);
			return res.json();
		},
		queryKey: ["v2", "admin", "trainings", "licenses", trainingId] as const,
		enabled,
		staleTime: 30_000,
	});

export const useRevokeLicense = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (licenseId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/licenses/${licenseId}/revoke`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					typeof data.detail === "string"
						? data.detail
						: "Couldn't revoke license",
				);
			}
			return res.json();
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			toast.success(t`License revoked`);
			queryClient.invalidateQueries({ queryKey: ["v2", "admin", "trainings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "training"] });
		},
	});
};
