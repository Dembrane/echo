// Tagged so callers can branch on "denied" vs transient failures.
// 401/403/404 all collapse here: the backend uses 404 to hide private
// workspaces from non-members (access_requests.py).
export class WorkspaceAccessDeniedError extends Error {
	readonly status: number;
	constructor(status: number, message?: string) {
		super(message ?? "Access denied");
		this.name = "WorkspaceAccessDeniedError";
		this.status = status;
	}
}
