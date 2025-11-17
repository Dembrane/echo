import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Menu,
	MultiSelect,
	Pagination,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Switch,
	Table,
	Text,
} from "@mantine/core";
import {
	IconArrowDown,
	IconArrowsSort,
	IconArrowUp,
	IconChevronDown,
	IconChevronUp,
	IconDatabaseSearch,
	IconDownload,
	IconFileTypeCsv,
	IconFileTypeJs,
	IconLogs,
	IconRefresh,
} from "@tabler/icons-react";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import {
	type AuditLogEntry,
	type AuditLogExportFormat,
	type AuditLogFilters,
	type AuditLogOption,
	useAuditLogMetadata,
	useAuditLogsExport,
	useAuditLogsQuery,
} from "./hooks";

const PAGE_SIZE_OPTIONS = ["10", "25", "50"];
const DEFAULT_PAGE_SIZE = 25;

const ACTION_BADGE_COLORS: Record<string, string> = {
	create: "green",
	delete: "red",
	login: "grape",
	update: "blue",
};

const extractDeltas = (entry: AuditLogEntry) => {
	return (entry.revisions ?? [])
		.map((revision) => revision?.delta)
		.filter((delta): delta is Record<string, unknown> => {
			return !!delta && Object.keys(delta).length > 0;
		});
};

const formatTimestamp = (value: string) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

const getActorLabel = (entry: AuditLogEntry) => {
	const name = [entry.user?.first_name, entry.user?.last_name]
		.filter(Boolean)
		.join(" ")
		.trim();

	if (name.length > 0) return name;
	if (entry.user?.email) return entry.user.email;
	return t`System`;
};

const toSelectData = (options: AuditLogOption[]) =>
	options.map((option) => ({
		label: `${option.label} (${option.count})`,
		value: option.value,
	}));

export const AuditLogsCard = () => {
	const [selectedActions, setSelectedActions] = useState<string[]>([]);
	const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
	const [pagination, setPagination] = useState({
		pageIndex: 0,
		pageSize: DEFAULT_PAGE_SIZE,
	});
	const [showIps, setShowIps] = useState(false);
	const [expandedRows, setExpandedRows] = useState<Set<number>>(
		() => new Set(),
	);
	const [sorting, setSorting] = useState<SortingState>([
		{
			desc: true,
			id: "timestamp",
		},
	]);

	const activeSort = sorting[0];
	const sortDirection: "asc" | "desc" =
		activeSort?.id === "timestamp" && activeSort?.desc === false
			? "asc"
			: "desc";

	const toggleRowExpansion = useCallback((id: number) => {
		setExpandedRows((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const isRowExpanded = useCallback(
		(id: number) => {
			return expandedRows.has(id);
		},
		[expandedRows],
	);

	const filters: AuditLogFilters = useMemo(
		() => ({
			actions: selectedActions,
			collections: selectedCollections,
		}),
		[selectedActions, selectedCollections],
	);

	const { data, error, isError, isFetching, isLoading, refetch } =
		useAuditLogsQuery({
			filters,
			page: pagination.pageIndex,
			pageSize: pagination.pageSize,
			sortDirection,
		});

	const { data: metadata, isLoading: isMetadataLoading } =
		useAuditLogMetadata();

	const exportMutation = useAuditLogsExport();

const totalItems = data?.total ?? 0;
const tableData = data?.items ?? [];
const displayedRows = useMemo(() => {
	if (tableData.length <= 1) return tableData;
	return [...tableData].sort((a, b) => {
		const aTime = new Date(a.timestamp).getTime();
		const bTime = new Date(b.timestamp).getTime();
		return sortDirection === "asc" ? aTime - bTime : bTime - aTime;
	});
}, [tableData, sortDirection]);
const totalPages = Math.max(
	1,
	Math.ceil(totalItems / pagination.pageSize),
);

	const columns = useMemo<ColumnDef<AuditLogEntry>[]>(
		() => [
			{
				accessorKey: "action",
				cell: ({ row }) => (
					<Badge
						variant="light"
						color={
							ACTION_BADGE_COLORS[row.original.action?.toLowerCase() ?? ""] ??
							"gray"
						}
						size="sm"
						className="w-fit uppercase"
					>
						{row.original.action}
					</Badge>
				),
				header: () => t`Type`,
			},
			{
				accessorKey: "collection",
				cell: ({ row }) => (
					<Text fw={500} size="sm">
						{row.original.collection}
					</Text>
				),
				header: () => t`Collection`,
			},
			{
				accessorKey: "item",
				cell: ({ row }) => {
					const deltas = extractDeltas(row.original);
					const hasRevisions = deltas.length > 0;
					const expanded = isRowExpanded(row.original.id);

					return (
						<Stack gap={4}>
							<Group
								gap={8}
								wrap="nowrap"
								align="center"
								justify="space-between"
							>
								<div className="min-w-0">
									<Text
										size="sm"
										className="font-medium truncate whitespace-nowrap"
									>
										{row.original.item}
									</Text>
									<Text
										size="xs"
										c="dimmed"
										className="mt-0.5 whitespace-nowrap"
									>
										#{row.original.id}
									</Text>
								</div>
								{hasRevisions ? (
									<Button
										variant="light"
										size="xs"
										onClick={() => toggleRowExpansion(row.original.id)}
										leftSection={<IconDatabaseSearch size={14} />}
										rightSection={
											expanded ? (
												<IconChevronUp size={14} />
											) : (
												<IconChevronDown size={14} />
											)
										}
										aria-label={
											expanded ? t`Hide revision data` : t`Show revision data`
										}
									>
										{expanded ? t`Hide data` : t`Show data`}
									</Button>
								) : null}
							</Group>
						</Stack>
					);
				},
				header: () => t`Action On`,
			},
			{
				accessorKey: "timestamp",
				cell: ({ row }) => (
					<Text size="sm" className="whitespace-nowrap">
						{formatTimestamp(row.original.timestamp)}
					</Text>
				),
				enableSorting: true,
				header: () => t`Timestamp`,
			},
			{
				accessorKey: "user",
				cell: ({ row }) => (
					<Text size="sm" className="max-w-[180px] truncate">
						{getActorLabel(row.original)}
					</Text>
				),
				header: () => t`Action By`,
			},
			{
				accessorKey: "ip",
				cell: ({ row }) => {
					if (!row.original.ip) {
						return <Text size="sm">{t`Unknown`}</Text>;
					}

					return (
						<Text size="sm" className="font-mono">
							{showIps ? row.original.ip : t`Hidden`}
						</Text>
					);
				},
				header: () => t`IP Address`,
			},
		],
		[isRowExpanded, showIps, toggleRowExpansion],
	);

	const table = useReactTable({
		columns,
		data: displayedRows,
		getCoreRowModel: getCoreRowModel(),
		manualPagination: true,
		manualSorting: true,
		onPaginationChange: (updater) => {
			setPagination((prev) => {
				const next =
					typeof updater === "function" ? updater(prev) : updater;
				return next;
			});
		},
		onSortingChange: (updater) => {
			setSorting((prev) => {
				const updated =
					typeof updater === "function" ? updater(prev) : updater;
				const next = updated.filter((entry) => entry.id === "timestamp");
				if (next.length === 0) {
					return [{ id: "timestamp", desc: true }];
				}
				return next;
			});
			setPagination((prev) => ({ ...prev, pageIndex: 0 }));
		},
		pageCount: totalPages,
		state: {
			pagination,
			sorting,
		},
	});

	const handlePageSizeChange = useCallback(
		(value: string | null) => {
			if (!value) return;
			const next = Number(value);
			table.setPageSize(next);
		},
		[table],
	);

	const handleActionsChange = useCallback(
		(value: string[]) => {
			setSelectedActions(value);
			table.setPageIndex(0);
		},
		[table],
	);

	const handleCollectionsChange = useCallback(
		(value: string[]) => {
			setSelectedCollections(value);
			table.setPageIndex(0);
		},
		[table],
	);

	useEffect(() => {
		const maxPageIndex = Math.max(0, totalPages - 1);
		if (pagination.pageIndex > maxPageIndex) {
			setPagination((prev) => ({ ...prev, pageIndex: maxPageIndex }));
		}
	}, [pagination.pageIndex, totalPages]);

	const handleExport = async (format: AuditLogExportFormat) => {
		try {
			const result = await exportMutation.mutateAsync({ filters, format });
			const blobUrl = URL.createObjectURL(result.blob);

			const link = document.createElement("a");
			link.href = blobUrl;
			link.download = result.filename;
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(blobUrl);

			toast.success(
				format === "csv"
					? t`Audit logs exported to CSV`
					: t`Audit logs exported to JSON`,
			);
		} catch (exportError) {
			const message =
				exportError instanceof Error
					? exportError.message
					: t`Something went wrong while exporting audit logs.`;
			toast.error(message);
		}
	};

	const isEmpty = !isLoading && displayedRows.length === 0;
	const displayFrom =
		totalItems === 0
			? 0
			: pagination.pageIndex * pagination.pageSize + 1;
	const displayTo = Math.min(
		totalItems,
		(pagination.pageIndex + 1) * pagination.pageSize,
	);

	return (
		<Paper
			withBorder
			radius="md"
			p="lg"
			className="shadow-sm bg-white dark:bg-dark-6"
		>
			<Stack gap="xl">
				<Group justify="space-between" align="flex-start">
					<Stack gap={4}>
						<Group gap="sm" align="center">
							<IconLogs size={20} />
							<Text size="lg" fw={600}>
								<Trans>Audit logs</Trans>
							</Text>
						</Group>
						<Text size="sm" c="dimmed" className="max-w-[520px]">
							<Trans>
								Review activity for your workspace. Filter by collection or
								action, and export the current view for further investigation.
							</Trans>
						</Text>
					</Stack>
					<Group gap="xs">
						<ActionIcon
							variant="subtle"
							aria-label={t`Refresh audit logs`}
							onClick={() => refetch()}
							disabled={isFetching && !isLoading}
						>
							{isFetching && !isLoading ? (
								<Loader size="xs" />
							) : (
								<IconRefresh size={16} />
							)}
						</ActionIcon>

						<Menu withinPortal position="bottom-end">
							<Menu.Target>
								<Button
									leftSection={<IconDownload size={16} />}
									loading={exportMutation.isPending}
								>
									<Trans>Export</Trans>
								</Button>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Label>
									<Trans>Download as</Trans>
								</Menu.Label>
								<Menu.Item
									leftSection={<IconFileTypeCsv size={16} />}
									onClick={() => handleExport("csv")}
								>
									CSV
								</Menu.Item>
								<Menu.Item
									leftSection={<IconFileTypeJs size={16} />}
									onClick={() => handleExport("json")}
								>
									JSON
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</Group>
				</Group>

				<Stack gap="sm">
					<Group align="flex-end" gap="md" wrap="wrap">
						<MultiSelect
							label={t`Filter by action`}
							placeholder={
								isMetadataLoading ? t`Loading actions...` : t`All actions`
							}
							data={toSelectData(metadata?.actions ?? [])}
							value={selectedActions}
							onChange={handleActionsChange}
							searchable
							clearable
							nothingFoundMessage={t`No actions found`}
							className="min-w-[220px]"
							aria-label={t`Filter audit logs by action`}
							disabled={isMetadataLoading}
						/>

						<MultiSelect
							label={t`Filter by collection`}
							placeholder={
								isMetadataLoading
									? t`Loading collections...`
									: t`All collections`
							}
							data={toSelectData(metadata?.collections ?? [])}
							value={selectedCollections}
							onChange={handleCollectionsChange}
							searchable
							clearable
							nothingFoundMessage={t`No collections found`}
							className="min-w-[220px]"
							aria-label={t`Filter audit logs by collection`}
							disabled={isMetadataLoading}
						/>

				<Switch
					label={t`Show IP addresses`}
					checked={showIps}
					onChange={(event) => setShowIps(event.currentTarget.checked)}
					labelPosition="left"
							size="sm"
						/>
					</Group>
				</Stack>

				{isError ? (
					<Alert color="red" variant="light">
						<Text size="sm">
							{error instanceof Error
								? error.message
								: t`Unable to load audit logs.`}
						</Text>
					</Alert>
				) : null}

				<ScrollArea
					offsetScrollbars
					className="rounded-md border border-gray-200 dark:border-dark-4"
				>
					<Table striped highlightOnHover>
						<Table.Thead className="bg-gray-50 dark:bg-dark-7">
						{table.getHeaderGroups().map((headerGroup) => (
							<Table.Tr key={headerGroup.id}>
								{headerGroup.headers.map((header) => {
									const canSort = header.column.getCanSort();
									const sortState = header.column.getIsSorted();
									const sortIcon =
										sortState === "desc"
											? <IconArrowDown size={14} />
										: sortState === "asc"
											?
												<IconArrowUp size={14} />
											: canSort
											?
												<IconArrowsSort size={14} className="text-gray-400" />
											: null;

								return (
									<Table.Th
										key={header.id}
										onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
										className={`uppercase tracking-wide text-xs font-semibold text-gray-600 dark:text-gray-3 ${canSort ? "cursor-pointer select-none" : ""}`}
										style={header.column.id === "item" ? { width: "1%" } : undefined}
									>
											{header.isPlaceholder ? null : (
												<Group gap={6} wrap="nowrap" align="center">
													{flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
													{sortIcon}
												</Group>
											)}
										</Table.Th>
									);
								})}
							</Table.Tr>
						))}
						</Table.Thead>

						<Table.Tbody>
							{isLoading ? (
								<Table.Tr>
									<Table.Td colSpan={columns.length}>
										<Group justify="center" py="xl">
											<Loader size="sm" />
											<Text size="sm" c="dimmed">
												<Trans>Loading audit logs…</Trans>
											</Text>
										</Group>
									</Table.Td>
								</Table.Tr>
							) : null}

							{!isLoading &&
								table.getRowModel().rows.map((row) => {
									const deltas = extractDeltas(row.original);
									const showDelta =
										deltas.length > 0 && isRowExpanded(row.original.id);

									return (
										<Fragment key={row.id}>
											<Table.Tr>
												{row.getVisibleCells().map((cell) => (
													<Table.Td key={cell.id}>
														{flexRender(
															cell.column.columnDef.cell,
															cell.getContext(),
														)}
													</Table.Td>
												))}
											</Table.Tr>
											{showDelta ? (
												<Table.Tr>
													<Table.Td colSpan={columns.length}>
														<Stack gap="xs">
															{deltas.map((delta, index) => {
																const revisionNumber = index + 1;

																return (
																	<div
																		key={revisionNumber}
																		className="rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs dark:border-dark-4 dark:bg-dark-7"
																	>
																		<Text size="xs" c="dimmed" className="mb-2">
																			<Trans>Revision #{revisionNumber}</Trans>
																		</Text>
																		<pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
																			{JSON.stringify(delta, null, 2)}
																		</pre>
																	</div>
																);
															})}
														</Stack>
													</Table.Td>
												</Table.Tr>
											) : null}
										</Fragment>
									);
								})}

							{isEmpty ? (
								<Table.Tr>
									<Table.Td colSpan={columns.length}>
										<Group justify="center" py="xl">
											<Text size="sm" c="dimmed">
												<Trans>No audit logs match the current filters.</Trans>
											</Text>
										</Group>
									</Table.Td>
								</Table.Tr>
							) : null}
						</Table.Tbody>
					</Table>
				</ScrollArea>

		<Group justify="space-between" align="center">
			<Group gap="sm" align="center">
				<Select
					label={t`Rows per page`}
					data={PAGE_SIZE_OPTIONS}
					value={pagination.pageSize.toString()}
					onChange={handlePageSizeChange}
					allowDeselect={false}
					className="w-[140px]"
				/>

				<Text size="sm" c="dimmed">
					{displayedRows.length === 0 && pagination.pageIndex === 0 ? (
						<Trans>No results</Trans>
					) : (
						<Trans>
							Showing {displayFrom}–{displayTo} of {totalItems} entries
						</Trans>
					)}
				</Text>
			</Group>

			<Pagination
				total={totalPages}
				value={pagination.pageIndex + 1}
				onChange={(pageNumber) => table.setPageIndex(pageNumber - 1)}
				disabled={totalPages <= 1}
			/>
		</Group>
			</Stack>
		</Paper>
	);
};

export default AuditLogsCard;
