import { t } from "@lingui/core/macro";
import type { AgentGrantStatus } from "./hooks";

export const formatDateTime = (value: string | null | undefined): string => {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

export const formatDate = (value: string | null | undefined): string => {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		date,
	);
};

export const scopeLabel = (scope: string): string => {
	if (scope === "read")
		return t`read conversations, transcripts, projects and settings you can see`;
	if (scope === "write") return t`change project settings`;
	return scope;
};

export const grantStatusLabel = (status: AgentGrantStatus): string => {
	if (status === "active") return t`Active`;
	if (status === "expired") return t`Expired`;
	return t`Revoked`;
};

export const grantStatusColor = (status: AgentGrantStatus): string =>
	status === "active" ? "green" : "gray";

// Audit rows: only "ok" is a success; denied, limited and error all read as
// the call not going through.
export const auditStatusColor = (status: string): string =>
	status === "ok" ? "green" : "red";
