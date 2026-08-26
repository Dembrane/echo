import { useMutation } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface SubmitIssueReportInput {
	message: string;
	workspaceId?: string;
	projectId?: string;
	pageUrl?: string;
	locale?: string;
	userAgent?: string;
	sessionReplayUrl?: string;
	attachments: File[];
}

export interface IssueReportResponse {
	report_id: string;
	support_request_id: string;
	attachment_count: number;
}

/** Field names are the endpoint's contract; renaming any of them is a silent 422. */
export const buildIssueReportFormData = (
	input: SubmitIssueReportInput,
): FormData => {
	const fd = new FormData();
	fd.append("message", input.message);
	if (input.workspaceId) fd.append("workspace_id", input.workspaceId);
	if (input.projectId) fd.append("project_id", input.projectId);
	if (input.pageUrl) fd.append("page_url", input.pageUrl);
	if (input.locale) fd.append("locale", input.locale);
	if (input.userAgent) fd.append("user_agent", input.userAgent);
	if (input.sessionReplayUrl)
		fd.append("session_replay_url", input.sessionReplayUrl);
	for (const file of input.attachments) {
		fd.append("attachments", file);
	}
	return fd;
};

/** Carries the HTTP status so the modal can pick specific copy. */
export class IssueReportError extends Error {
	status: number;

	constructor(status: number, detail: string) {
		super(detail || "Request failed");
		this.name = "IssueReportError";
		this.status = status;
	}
}

const submitIssueReport = async (
	input: SubmitIssueReportInput,
): Promise<IssueReportResponse> => {
	const response = await fetch(`${API_BASE_URL}/v2/feedback/reports`, {
		body: buildIssueReportFormData(input),
		credentials: "include",
		method: "POST",
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const detail = typeof data.detail === "string" ? data.detail : "";
		throw new IssueReportError(response.status, detail);
	}
	return response.json();
};

export const useSubmitIssueReportMutation = () =>
	useMutation({ mutationFn: submitIssueReport });
