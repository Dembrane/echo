import { readActivities, type DirectusActivity, type Query } from "@directus/sdk";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { directus } from "@/lib/directus";

export interface AuditLogUser {
	email?: string | null;
	first_name?: string | null;
	id?: string | null;
	last_name?: string | null;
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
}

export interface AuditLogFilters {
	actions?: string[];
	collections?: string[];
}

export interface AuditLogQueryArgs {
	filters?: AuditLogFilters;
	page: number;
	pageSize: number;
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

const AUDIT_LOG_FIELDS = [
	"id",
	"action",
	"collection",
	"item",
	"timestamp",
	"ip",
	"user_agent",
	{
		user: ["id", "email", "first_name", "last_name"],
	},
] as const;

const AGGREGATE_BATCH_SIZE = 500;

type ActivityResponse<T> = T[] & {
	meta?: {
		filter_count?: number | string | null;
	};
};
type ActivitiesQuery = Query<
	CustomDirectusTypes,
	DirectusActivity<CustomDirectusTypes>
>;

const buildFilter = (
	filters?: AuditLogFilters,
): ActivitiesQuery["filter"] | undefined => {
	if (!filters) return undefined;

	const filter: Record<string, unknown> = {};

	if (filters.actions && filters.actions.length > 0) {
		filter.action = {
			_in: filters.actions,
		};
	}

	if (filters.collections && filters.collections.length > 0) {
		filter.collection = {
			_in: filters.collections,
		};
	}

	return Object.keys(filter).length > 0
		? (filter as ActivitiesQuery["filter"])
		: undefined;
};

const normalizeCount = (value: unknown): number => {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	if (typeof value === "object" && value !== null) {
		const firstValue = Object.values(value)[0];
		if (typeof firstValue === "number") return firstValue;
		if (typeof firstValue === "string") {
			const parsed = Number.parseInt(firstValue, 10);
			return Number.isNaN(parsed) ? 0 : parsed;
		}
	}
	return 0;
};

const fetchAuditLogsPage = async ({
	filters,
	page,
	pageSize,
}: AuditLogQueryArgs): Promise<AuditLogQueryResult> => {
	const filter = buildFilter(filters);

	const response = await directus.request<ActivityResponse<AuditLogEntry>>(
		readActivities<CustomDirectusTypes, ActivitiesQuery>(
			{
				fields: AUDIT_LOG_FIELDS as unknown as ActivitiesQuery["fields"],
				filter,
				limit: pageSize,
				meta: "filter_count",
				offset: page * pageSize,
				sort: ["-timestamp"],
			} as unknown as ActivitiesQuery,
		),
	);

	const items = [...response];
	const metaTotal = response.meta?.filter_count;
	const normalizedTotal = normalizeCount(metaTotal);

	return {
		items,
		total: normalizedTotal > 0 ? normalizedTotal : page * pageSize + items.length,
	};
};

const fetchAuditLogOptions = async (): Promise<AuditLogMetadata> => {
	const [actions, collections] = await Promise.all([
		directus.request<
			Array<{
				action: string | null;
				count: number;
			}>
		>(
			readActivities<CustomDirectusTypes, ActivitiesQuery>(
				{
					aggregate: {
						count: "*",
					},
					groupBy: ["action"],
					sort: ["action"],
				} as unknown as ActivitiesQuery,
			),
		),
		directus.request<
			Array<{
				collection: string | null;
				count: number;
			}>
		>(
			readActivities<CustomDirectusTypes, ActivitiesQuery>(
				{
					aggregate: {
						count: "*",
					},
					groupBy: ["collection"],
					sort: ["collection"],
				} as unknown as ActivitiesQuery,
			),
		),
	]);

	const toOptions = <T extends { count: number }>(
		items: Array<T & Record<string, unknown>>,
		key: string,
	): AuditLogOption[] => {
		return items
			.map((item) => {
				const rawValue = item[key];
				if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
					return null;
				}

				return {
					count: normalizeCount(item.count),
					label: rawValue,
					value: rawValue,
				};
			})
			.filter(
				(option): option is AuditLogOption => option !== null && !!option.value,
			);
	};

	return {
		actions: toOptions(actions, "action"),
		collections: toOptions(collections, "collection"),
	};
};

const fetchAuditLogsForExport = async ({
	filters,
}: {
	filters?: AuditLogFilters;
}) => {
	const filter = buildFilter(filters);

	let offset = 0;
	const records: AuditLogEntry[] = [];

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const batch = await directus.request<ActivityResponse<AuditLogEntry>>(
			readActivities<CustomDirectusTypes, ActivitiesQuery>(
				{
					fields: AUDIT_LOG_FIELDS as unknown as ActivitiesQuery["fields"],
					filter,
					limit: AGGREGATE_BATCH_SIZE,
					offset,
					sort: ["-timestamp"],
				} as unknown as ActivitiesQuery,
			),
		);

		records.push(...batch);

		if (batch.length < AGGREGATE_BATCH_SIZE) {
			break;
		}

		offset += AGGREGATE_BATCH_SIZE;
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
		if (stringValue.includes('"') || stringValue.includes(",") || stringValue.includes("\n")) {
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
					.trim() || row.user?.email || "System";

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

const createExportBlob = (rows: AuditLogEntry[], format: AuditLogExportFormat) => {
	if (format === "csv") {
		return new Blob([toCsv(rows)], { type: "text/csv" });
	}

	return new Blob([toJson(rows)], { type: "application/json" });
};

export const useAuditLogsQuery = (args: AuditLogQueryArgs) => {
	const queryKey = ["settings", "auditLogs", "list", args] as const;

	return useQuery<AuditLogQueryResult>({
		queryFn: () => fetchAuditLogsPage(args),
		queryKey,
		placeholderData: keepPreviousData,
		meta: {
			description: "Fetches paginated Directus audit logs",
		},
	});
};

export const useAuditLogMetadata = () => {
	const queryKey = ["settings", "auditLogs", "metadata"] as const;

	return useQuery<AuditLogMetadata>({
		queryFn: fetchAuditLogOptions,
		queryKey,
		staleTime: 5 * 60 * 1000,
		meta: {
			description: "Fetches available action and collection filters for audit logs",
		},
	});
};

export const useAuditLogsExport = () => {
	return useMutation({
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
		meta: {
			description: "Exports filtered audit logs as CSV or JSON",
		},
	});
};
