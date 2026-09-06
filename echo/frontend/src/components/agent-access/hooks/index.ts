import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

// Agent access: the dashboard side of connecting an AI agent over MCP + OAuth.
// Every call here is session-authenticated (cookie) against /v2/agent-access.

export interface AgentServer {
	id: string;
	name: string;
	summary: string;
	data_reach: string[];
	can_change: string[];
	tools: string[];
	mcp_url: string;
	scopes: string[];
}

export interface AgentServersResponse {
	servers: AgentServer[];
	consent_version: string;
	expiry_choices_days: number[];
	free_tier_monthly_calls: number;
}

export interface OrgAgentAccess {
	id: string;
	name: string;
	role: string;
	can_manage: boolean;
	agent_access_enabled: boolean;
	is_paid: boolean;
	calls_this_month: number;
	monthly_limit: number | null;
	updated_at: string | null;
}

export type AgentGrantStatus = "active" | "expired" | "revoked";

export interface AgentGrant {
	id: string;
	client_id: string;
	client_name: string;
	org_ids: string[];
	org_names: string[];
	scopes: string[];
	created_at: string;
	expires_at: string | null;
	last_used_at: string | null;
	revoked_at: string | null;
	status: AgentGrantStatus;
	user_email: string | null;
	user_display_name: string | null;
}

export interface AgentAuditEvent {
	id: string;
	grant_id: string;
	client_id: string;
	client_name: string | null;
	app_user_id: string;
	user_display_name: string | null;
	user_email: string | null;
	org_id: string | null;
	tool: string;
	params: Record<string, unknown>;
	status: string;
	duration_ms: number | null;
	created_at: string | null;
}

export interface AgentAuthorizeRequest {
	request_id: string;
	client_name: string;
	client_id: string;
	redirect_host: string;
	requested_scopes: string[];
	organisations: OrgAgentAccess[];
	consent_version: string;
	expiry_choices_days: number[];
}

export class AgentAccessError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const request = async <TResponse>(
	path: string,
	init: RequestInit = {},
): Promise<TResponse> => {
	const response = await fetch(`${API_BASE_URL}/v2/agent-access${path}`, {
		credentials: "include",
		...init,
		headers: {
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new AgentAccessError(
			response.status,
			typeof data.detail === "string" ? data.detail : t`Request failed`,
		);
	}
	const text = await response.text();
	return text ? JSON.parse(text) : ({} as TResponse);
};

export const agentAccessKeys = {
	all: ["v2", "agent-access"] as const,
	authorizeRequest: (requestId: string) =>
		["v2", "agent-access", "authorize-requests", requestId] as const,
	grants: () => ["v2", "agent-access", "grants"] as const,
	orgAudit: (orgId: string) =>
		["v2", "agent-access", "organisations", orgId, "audit"] as const,
	organisations: () => ["v2", "agent-access", "organisations"] as const,
	orgGrants: (orgId: string) =>
		["v2", "agent-access", "organisations", orgId, "grants"] as const,
	servers: () => ["v2", "agent-access", "servers"] as const,
};

export const useAgentServersQuery = () =>
	useQuery({
		queryFn: () => request<AgentServersResponse>("/servers"),
		queryKey: agentAccessKeys.servers(),
		staleTime: 5 * 60_000,
	});

export const useAgentOrganisationsQuery = () =>
	useQuery({
		queryFn: () => request<OrgAgentAccess[]>("/organisations"),
		queryKey: agentAccessKeys.organisations(),
		staleTime: 60_000,
	});

export const useAgentGrantsQuery = () =>
	useQuery({
		queryFn: () => request<AgentGrant[]>("/grants"),
		queryKey: agentAccessKeys.grants(),
		staleTime: 30_000,
	});

export const useOrgAgentGrantsQuery = (orgId: string | undefined) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () => request<AgentGrant[]>(`/organisations/${orgId}/grants`),
		queryKey: agentAccessKeys.orgGrants(orgId ?? ""),
		staleTime: 30_000,
	});

export const useOrgAgentAuditQuery = (orgId: string | undefined) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () =>
			request<AgentAuditEvent[]>(
				`/audit?org_id=${encodeURIComponent(orgId ?? "")}&limit=30`,
			),
		queryKey: agentAccessKeys.orgAudit(orgId ?? ""),
		staleTime: 30_000,
	});

export const useAgentAuthorizeRequestQuery = (requestId: string | null) =>
	useQuery({
		enabled: Boolean(requestId),
		queryFn: () =>
			request<AgentAuthorizeRequest>(`/authorize-requests/${requestId}`),
		queryKey: agentAccessKeys.authorizeRequest(requestId ?? ""),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

// Flipping the org switch changes what every member's agent may do, so
// every surface that shows the flag (settings, consent, org page) refetches.
export const useSetOrgAgentAccessMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ orgId, enabled }: { orgId: string; enabled: boolean }) =>
			request<OrgAgentAccess>(`/organisations/${orgId}`, {
				body: JSON.stringify({ enabled }),
				method: "PATCH",
			}),
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: (org) => {
			queryClient.invalidateQueries({ queryKey: agentAccessKeys.all });
			toast.success(
				org.agent_access_enabled
					? t`MCP access for ${org.name} is on`
					: t`MCP access for ${org.name} is off`,
			);
		},
	});
};

export const useRevokeAgentGrantMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ grantId, orgId }: { grantId: string; orgId?: string }) =>
			request<{ status: "revoked" }>(
				orgId
					? `/organisations/${orgId}/grants/${grantId}`
					: `/grants/${grantId}`,
				{ method: "DELETE" },
			),
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: agentAccessKeys.all });
			toast.success(t`Connection revoked`);
		},
	});
};

export const useApproveAuthorizeRequestMutation = () =>
	useMutation({
		mutationFn: ({
			requestId,
			orgIds,
			scopes,
			expiresInDays,
		}: {
			requestId: string;
			orgIds: string[];
			scopes: string[];
			expiresInDays: number;
		}) =>
			request<{ redirect_url: string }>(
				`/authorize-requests/${requestId}/approve`,
				{
					body: JSON.stringify({
						consent_accepted: true,
						expires_in_days: expiresInDays,
						org_ids: orgIds,
						scopes,
					}),
					method: "POST",
				},
			),
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

export const useDenyAuthorizeRequestMutation = () =>
	useMutation({
		mutationFn: ({ requestId }: { requestId: string }) =>
			request<{ redirect_url: string }>(
				`/authorize-requests/${requestId}/deny`,
				{ method: "POST" },
			),
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});
