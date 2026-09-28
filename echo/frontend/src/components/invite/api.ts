import type { InviteRole } from "@/components/invite/RoleSelect";
import { API_BASE_URL } from "@/config";

// Error from an invite/sharing endpoint. `code` is set when the server sends a
// structured `detail` ({ code, message }) the UI branches on; `body` is the whole
// response, which the error presenter (lib/errors) reads the catalog code from.
export class ApiError extends Error {
	status: number;
	code?: string;
	body?: unknown;

	constructor(message: string, status: number, code?: string, body?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

// FastAPI `detail` is either a plain string or `{ code, message }`.
export function parseApiError(
	status: number,
	data: unknown,
	fallback: string,
): ApiError {
	const detail = (data as { detail?: unknown } | null)?.detail;
	if (typeof detail === "string" && detail) {
		return new ApiError(detail, status, undefined, data);
	}
	if (detail && typeof detail === "object") {
		const { code, message } = detail as { code?: string; message?: string };
		return new ApiError(message || fallback, status, code, data);
	}
	return new ApiError(fallback, status, undefined, data);
}

export type ProjectShareOutcome =
	| "granted"
	| "pending"
	| "pending_other_project";

export type WorkspaceInvitePayload = {
	// invited | added | reactivated | already_member | already_invited
	status: string;
	email: string;
	user_existed?: boolean;
	email_sent: boolean;
	invite_url?: string | null;
	// Only when the invite carried a project (see inviteToWorkspace opts.projectId).
	project_share?: ProjectShareOutcome | null;
};

export type OrgInvitePayload = {
	status: string;
	email: string;
	invite_url?: string | null;
};

// POST /v2/orgs/:id/invites.
export async function inviteToOrg(
	orgId: string,
	email: string,
	role: InviteRole,
): Promise<OrgInvitePayload> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/invites`, {
		body: JSON.stringify({ email, role }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw parseApiError(res.status, data, `Org invite failed (${res.status})`);
	}
	return data as OrgInvitePayload;
}

// POST /v2/workspaces/:id/invite. With `projectId`, the invite also shares that
// private project on join (the share level follows the workspace role).
export async function inviteToWorkspace(
	workspaceId: string,
	email: string,
	role: InviteRole,
	opts: { projectId?: string } = {},
): Promise<WorkspaceInvitePayload> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({
				email,
				role,
				...(opts.projectId ? { project_id: opts.projectId } : {}),
			}),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw parseApiError(
			res.status,
			data,
			`Workspace invite failed (${res.status})`,
		);
	}
	return data as WorkspaceInvitePayload;
}
