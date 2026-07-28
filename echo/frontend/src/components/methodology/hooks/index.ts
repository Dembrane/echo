import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { APP_ENVIRONMENT } from "@/config";
import { bff } from "@/lib/bff";
import { createFixtureMethodologies } from "../fixtures";

export type MethodologyVersionSummary = {
	id: string;
	note: string | null;
	created_at: string | null;
};

export type MethodologyVersionDetail = MethodologyVersionSummary & {
	created_by: string | null;
	content: unknown;
};

export type MethodologyListItem = {
	id: string;
	name: string;
	description: string;
	framing: string;
	is_seeded: boolean;
	latest_version: MethodologyVersionSummary | null;
	versions_count?: number;
	isDevFixture?: boolean;
};

export type MethodologyDetail = MethodologyListItem & {
	versions: MethodologyVersionDetail[];
};

export type MethodologyCreatePayload = {
	workspace_id: string;
	name: string;
	description: string;
	framing: string;
	content?: unknown;
};

export type MethodologyEditPayload = {
	id: string;
	name?: string;
	description?: string;
	framing?: string;
	content?: unknown;
	note?: string;
};

type BffError = Error & { status?: number };

export const methodologyQueryKeys = {
	list: (workspaceId: string) => ["methodologies", workspaceId] as const,
	detail: (methodologyId: string) => ["methodologies", "detail", methodologyId] as const,
};

function isFixtureEligibleMiss(error: unknown): boolean {
	const bffError = error as BffError;
	if (APP_ENVIRONMENT !== "local") return false;
	return (
		bffError?.status === 404 ||
		bffError?.message === "HTTP 404" ||
		error instanceof TypeError ||
		bffError?.message === "Failed to fetch" ||
		bffError?.message.includes("fetch failed")
	);
}

async function listMethodologies(workspaceId: string): Promise<MethodologyListItem[]> {
	try {
		return await bff.get<MethodologyListItem[]>("/methodologies", {
			workspace_id: workspaceId,
		});
	} catch (error) {
		if (isFixtureEligibleMiss(error)) {
			return createFixtureMethodologies(workspaceId).map((item) => ({
				...item,
				isDevFixture: true,
			}));
		}
		throw error;
	}
}

export function useMethodologies(workspaceId: string | null | undefined) {
	return useQuery({
		enabled: !!workspaceId,
		queryFn: () => listMethodologies(workspaceId ?? ""),
		queryKey: methodologyQueryKeys.list(workspaceId ?? ""),
	});
}

export function useMethodologyDetail(methodologyId: string | null | undefined) {
	return useQuery({
		enabled: !!methodologyId,
		queryFn: () => bff.get<MethodologyDetail>(`/methodologies/${methodologyId}`),
		queryKey: methodologyQueryKeys.detail(methodologyId ?? ""),
	});
}

export function useCreateMethodologyMutation(workspaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: Omit<MethodologyCreatePayload, "workspace_id">) =>
			bff.post<MethodologyListItem>("/methodologies", {
				...payload,
				workspace_id: workspaceId,
			}),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not create this methodology`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: methodologyQueryKeys.list(workspaceId),
			});
			toast.success(t`Methodology created`);
		},
	});
}

export function useEditMethodologyMutation(workspaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...payload }: MethodologyEditPayload) =>
			bff.post<MethodologyListItem>(`/methodologies/${id}/versions`, payload),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not save this methodology`);
		},
		onSuccess: (methodology) => {
			queryClient.invalidateQueries({
				queryKey: methodologyQueryKeys.list(workspaceId),
			});
			queryClient.invalidateQueries({
				queryKey: methodologyQueryKeys.detail(methodology.id),
			});
			toast.success(t`Methodology saved`);
		},
	});
}

export function useSelectProjectMethodologyMutation(projectId: string, workspaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (methodologyVersionId: string) =>
			bff.patch(`/projects/${projectId}`, {
				methodology_version_id: methodologyVersionId,
			}),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not update this project's methodology`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
			queryClient.invalidateQueries({
				queryKey: methodologyQueryKeys.list(workspaceId),
			});
			toast.success(t`Methodology updated`);
		},
	});
}
