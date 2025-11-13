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
	Table,
	Text,
	Tooltip,
} from "@mantine/core";
import {
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
	useReactTable,
} from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
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
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

	const filters: AuditLogFilters = useMemo(
		() => ({
			actions: selectedActions,
			collections: selectedCollections,
		}),
		[selectedActions, selectedCollections],
	);

	const pageIndex = page - 1;

	const { data, error, isError, isFetching, isLoading, refetch } =
		useAuditLogsQuery({
			filters,
			page: pageIndex,
			pageSize,
		});

	const { data: metadata, isLoading: isMetadataLoading } =
		useAuditLogMetadata();

	const exportMutation = useAuditLogsExport();

	const totalItems = data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

	const tableData = data?.items ?? [];

	const columns = useMemo<ColumnDef<AuditLogEntry>[]>(
		() => [
			{
				accessorKey: "action",
				cell: ({ row }) => (
					<Stack gap={4}>
						<Badge
							variant="light"
							color="blue"
							size="sm"
							className="w-fit uppercase"
						>
							{row.original.action}
						</Badge>
						<Text size="xs" c="dimmed">
							{formatTimestamp(row.original.timestamp)}
						</Text>
					</Stack>
				),
				header: () => t`Action`,
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
				cell: ({ row }) => <Text size="sm">{row.original.item}</Text>,
				header: () => t`Action On`,
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
				cell: ({ row }) => (
					<Text size="sm">{row.original.ip ?? t`Unknown`}</Text>
				),
				header: () => t`IP Address`,
			},
			{
				accessorKey: "user_agent",
				cell: ({ row }) => {
					const agent = row.original.user_agent;

					if (!agent) {
						return <Text size="sm">{t`Unknown`}</Text>;
					}

					return (
						<Tooltip
							label={agent}
							position="top-start"
							withArrow
							multiline
							maw={360}
						>
							<Text size="sm" className="max-w-[240px] truncate">
								{agent}
							</Text>
						</Tooltip>
					);
				},
				header: () => t`User Agent`,
			},
		],
		[],
	);

	const table = useReactTable({
		columns,
		data: tableData,
		getCoreRowModel: getCoreRowModel(),
		manualPagination: true,
		pageCount: totalPages,
		state: {
			pagination: {
				pageIndex,
				pageSize,
			},
		},
	});

	const handlePageSizeChange = (value: string | null) => {
		if (!value) return;
		const next = Number(value);
		setPageSize(next);
		setPage(1);
	};

	const handleActionsChange = (value: string[]) => {
		setSelectedActions(value);
		setPage(1);
	};

	const handleCollectionsChange = (value: string[]) => {
		setSelectedCollections(value);
		setPage(1);
	};

	useEffect(() => {
		if (page > totalPages) {
			setPage(totalPages);
		}
	}, [page, totalPages]);

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

	const isEmpty = !isLoading && tableData.length === 0;
	const displayFrom = totalItems === 0 ? 0 : pageIndex * pageSize + 1;
	const displayTo = Math.min(totalItems, (pageIndex + 1) * pageSize);

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

						<Select
							label={t`Rows per page`}
							data={PAGE_SIZE_OPTIONS}
							value={pageSize.toString()}
							onChange={handlePageSizeChange}
							allowDeselect={false}
							className="w-[140px]"
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
									{headerGroup.headers.map((header) => (
										<Table.Th
											key={header.id}
											className="uppercase tracking-wide text-xs font-semibold text-gray-600 dark:text-gray-3"
										>
											{header.isPlaceholder
												? null
												: flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
										</Table.Th>
									))}
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
								table.getRowModel().rows.map((row) => (
									<Table.Tr key={row.id}>
										{row.getVisibleCells().map((cell) => (
											<Table.Td key={cell.id}>
												{flexRender(
													cell.column.columnDef.cell,
													cell.getContext(),
												)}
											</Table.Td>
										))}
									</Table.Tr>
								))}

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
					<Text size="sm" c="dimmed">
						{totalItems === 0 ? (
							<Trans>No results</Trans>
						) : (
							<Trans>
								Showing {displayFrom}–{displayTo} of {totalItems} entries
							</Trans>
						)}
					</Text>

					<Pagination
						total={totalPages}
						value={page}
						onChange={setPage}
						disabled={totalItems === 0}
					/>
				</Group>
			</Stack>
		</Paper>
	);
};

export default AuditLogsCard;
