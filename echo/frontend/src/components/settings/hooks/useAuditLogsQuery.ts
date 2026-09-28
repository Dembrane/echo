import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface AuditLogUser {
	email?: string | null;
	first_name?: string | null;
	id?: string | null;
	last_name?: string | null;
}

export interface AuditLogRevision {
	delta?: Record<string, unknown> | null;
}

export interface AuditLogEntry {
	action: string;
	collection: string;
	id: number;
	ip?: string | null;
	item: string;
	timestamp: string;
	user?: AuditLogUser | null;
	user_agent?: string | null;
	revisions?: AuditLogRevision[] | null;
}

export interface AuditLogFilters {
	actions?: string[];
	collections?: string[];
}

export interface AuditLogQueryArgs {
	filters?: AuditLogFilters;
	page: number;
	pageSize: number;
	sortDirection?: "asc" | "desc";
}

export interface AuditLogQueryResult {
	items: AuditLogEntry[];
	total: number;
}

export interface AuditLogOption {
	count: number;
	label: string;
	value: string;
}

export interface AuditLogMetadata {
	actions: AuditLogOption[];
	collections: AuditLogOption[];
}

export type AuditLogExportFormat = "csv" | "json";

export interface AuditLogExportArgs {
	filters?: AuditLogFilters;
	format: AuditLogExportFormat;
}

export interface AuditLogExportResult {
	blob: Blob;
	filename: string;
}

const AGGREGATE_BATCH_SIZE = 500;

/**
 * /user-settings/audit-logs answers with the rows the caller may see: staff all activity,
 * everyone else the rows by or about themselves, the scope Directus applied.
 */
const getJson = async <T>(
	path: string,
	params: Record<string, string | number | undefined> = {},
): Promise<T> => {
	const url = new URL(
		`${API_BASE_URL}/user-settings/audit-logs${path}`,
		window.location.origin,
	);
	for (const [k, v] of Object.entries(params))
		if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) throw new Error(`Audit log request failed: ${res.status}`);
	return res.json();
};

const filterParams = (filters?: AuditLogFilters) => ({
	actions: filters?.actions?.join(","),
	collections: filters?.collections?.join(","),
});

const fetchAuditLogsPage = async ({
	filters,
	page,
	pageSize,
	sortDirection,
}: AuditLogQueryArgs): Promise<AuditLogQueryResult> =>
	getJson<AuditLogQueryResult>("", {
		...filterParams(filters),
		page,
		page_size: pageSize,
		sort: sortDirection === "asc" ? "asc" : "desc",
	});

const fetchAuditLogOptions = async (): Promise<AuditLogMetadata> =>
	getJson<AuditLogMetadata>("/options");

const fetchAuditLogsForExport = async ({
	filters,
}: {
	filters?: AuditLogFilters;
}) => {
	const records: AuditLogEntry[] = [];

	for (let page = 0; ; page++) {
		const { items } = await getJson<AuditLogQueryResult>("", {
			...filterParams(filters),
			page,
			page_size: AGGREGATE_BATCH_SIZE,
			sort: "desc",
		});
		records.push(...items);
		if (items.length < AGGREGATE_BATCH_SIZE) break;
	}

	return records;
};

const toCsv = (rows: AuditLogEntry[]) => {
	const header = [
		"action",
		"collection",
		"action_on",
		"action_by",
		"timestamp",
		"ip_address",
		"user_agent",
	];

	const csvEscape = (value: unknown) => {
		if (value === null || value === undefined) return "";
		const stringValue = String(value);
		if (
			stringValue.includes('"') ||
			stringValue.includes(",") ||
			stringValue.includes("\n")
		) {
			return `"${stringValue.replace(/"/g, '""')}"`;
		}
		return stringValue;
	};

	const rowsAsString = rows
		.map((row) => {
			const actionBy =
				[row.user?.first_name, row.user?.last_name]
					.filter(Boolean)
					.join(" ")
					.trim() ||
				row.user?.email ||
				"System";

			return [
				csvEscape(row.action),
				csvEscape(row.collection),
				csvEscape(row.item),
				csvEscape(actionBy),
				csvEscape(row.timestamp),
				csvEscape(row.ip),
				csvEscape(row.user_agent),
			].join(",");
		})
		.join("\n");

	return `${header.join(",")}\n${rowsAsString}`;
};

const toJson = (rows: AuditLogEntry[]) => {
	return JSON.stringify(rows, null, 2);
};

const createExportBlob = (
	rows: AuditLogEntry[],
	format: AuditLogExportFormat,
) => {
	if (format === "csv") {
		return new Blob([toCsv(rows)], { type: "text/csv" });
	}

	return new Blob([toJson(rows)], { type: "application/json" });
};

export const useAuditLogsQuery = (args: AuditLogQueryArgs) => {
	const queryKey = ["settings", "auditLogs", "list", args] as const;

	return useQuery<AuditLogQueryResult>({
		meta: {
			description: "Fetches paginated audit logs",
		},
		placeholderData: keepPreviousData,
		queryFn: () => fetchAuditLogsPage(args),
		queryKey,
	});
};

export const useAuditLogMetadata = () => {
	const queryKey = ["settings", "auditLogs", "metadata"] as const;

	return useQuery<AuditLogMetadata>({
		meta: {
			description:
				"Fetches available action and collection filters for audit logs",
		},
		queryFn: fetchAuditLogOptions,
		queryKey,
		staleTime: 5 * 60 * 1000,
	});
};

export const useAuditLogsExport = () => {
	return useMutation({
		meta: {
			description: "Exports filtered audit logs as CSV or JSON",
		},
		mutationFn: async ({
			filters,
			format,
		}: AuditLogExportArgs): Promise<AuditLogExportResult> => {
			const rows = await fetchAuditLogsForExport({ filters });
			const blob = createExportBlob(rows, format);
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");

			return {
				blob,
				filename: `audit-logs-${stamp}.${format}`,
			};
		},
	});
};
