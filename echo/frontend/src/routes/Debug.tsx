import {
  Button,
  Divider,
  Group,
  Stack,
  Title,
  Table,
  Badge,
  Text,
  ScrollArea,
  Select,
  TextInput,
  Checkbox,
} from "@mantine/core";
import { toast } from "@/components/common/Toaster";
import { useRef, useState, useMemo, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  useConversationById,
  useCurrentUser,
  useProcessingStatus,
  useProjectById,
  useProjectChats,
} from "@/lib/query";
import {
  ENABLE_CHAT_AUTO_SELECT,
  API_BASE_URL,
  DIRECTUS_PUBLIC_URL,
  ADMIN_BASE_URL,
  PARTICIPANT_BASE_URL,
  BUILD_VERSION,
  DIRECTUS_CONTENT_PUBLIC_URL,
  SUPPORTED_LANGUAGES,
} from "@/config";
import { format, parseISO } from "date-fns";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getGroupedRowModel,
  getPaginationRowModel,
  flexRender,
  createColumnHelper,
  ColumnFiltersState,
  VisibilityState,
  GroupingState,
  ExpandedState,
  Row,
} from "@tanstack/react-table";

interface ProcessingStatus {
  id: string;
  timestamp: string;
  event?: string | null;
  item_id?: string;
  collection_name?: string;
  duration_ms?: number | null;
  message?: string | null;
  json?: any;
  subRows?: ProcessingStatus[];
}

const getStatusColor = (status: string | null | undefined): string => {
  const statusString = typeof status === "string" ? status : "";
  switch (statusString.toLowerCase()) {
    case "started":
      return "blue";
    case "processing":
      return "violet";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "error":
      return "red";
    default:
      return "gray";
  }
};

// Row renderer component for handling the recursive rendering of rows
function TableRowRenderer({
  row,
  flexRender,
  columns,
}: {
  row: Row<ProcessingStatus>;
  flexRender: any;
  columns: any[];
}) {
  // More detailed debugging information

  // Check if this is a parent row with expanded children
  const isParentWithChildren = row.subRows && row.subRows.length > 0;
  const isChildRow = row.depth > 0;

  // Styling for different row types
  const getRowStyle = () => {
    if (row.getIsGrouped()) {
      return {
        background: "#f9f9f9",
        borderTop: "2px solid #ddd",
        borderBottom: row.getIsExpanded() ? "1px solid #ddd" : "2px solid #ddd",
      };
    } else if (isChildRow) {
      return {
        background: "#f0ffff",
        borderLeft: "3px solid #bcd",
      };
    }
    return {};
  };

  return (
    <>
      <tr style={getRowStyle()}>
        {row.getVisibleCells().map((cell, cellIndex) => (
          <td
            key={cell.id}
            style={{
              background: cell.getIsGrouped()
                ? "#f0f8ff"
                : cell.getIsAggregated()
                  ? "#f5f5f5"
                  : cell.getIsPlaceholder()
                    ? "#fafafa"
                    : undefined,
              fontWeight: cell.getIsGrouped() ? "bold" : undefined,
              // Add left padding to the first cell of child rows to create visual hierarchy
              paddingLeft:
                isChildRow && cellIndex === 0
                  ? `${row.depth * 20}px`
                  : undefined,
              // Add a subtle left border to all cells in a child row
              borderLeft:
                isChildRow && cellIndex > 0 ? "1px solid #eee" : undefined,
            }}
          >
            {/* Cell in a grouping column */}
            {cell.getIsGrouped() && (
              <>
                <Button
                  size="xs"
                  mr={2}
                  onClick={(e) => {
                    e.stopPropagation();
                    row.getToggleExpandedHandler()();
                  }}
                  variant="subtle"
                  color={row.getIsExpanded() ? "blue" : "gray"}
                  style={{
                    boxShadow: row.getIsExpanded()
                      ? "0 0 2px rgba(0,0,0,0.2)"
                      : "none",
                    transition: "all 0.2s",
                  }}
                >
                  {row.getIsExpanded() ? "👇" : "👉"}
                  {row.subRows?.length > 0 && (
                    <Text size="xs" span ml={4}>
                      ({row.subRows.length})
                    </Text>
                  )}
                </Button>
                {flexRender(
                  cell.column.columnDef.aggregatedCell ??
                    cell.column.columnDef.cell,
                  cell.getContext(),
                )}{" "}
                ({row.subRows?.length ?? 0})
              </>
            )}

            {/* Aggregated cell in a group row (but not the grouping column itself) */}
            {/* Also handles normal cells if they are not grouped, not placeholder */}
            {!cell.getIsGrouped() &&
              !cell.getIsPlaceholder() &&
              flexRender(cell.column.columnDef.cell, cell.getContext())}

            {/* Placeholder cell (rendered if not grouped and no other content applies) */}
            {cell.getIsPlaceholder() && !cell.getIsGrouped() && (
              <span>-</span> // Show a dash for placeholders
            )}
          </td>
        ))}
      </tr>

      {/* Recursively render subrows if this row is expanded */}
      {row.getIsExpanded() && row.subRows && row.subRows.length > 0 && (
        <>
          {row.subRows.map((subRow) => (
            <TableRowRenderer
              key={subRow.id}
              row={subRow}
              flexRender={flexRender}
              columns={columns}
            />
          ))}
          {/* Visual divider after subrows */}
          <tr style={{ height: "4px", background: "#f0f0f0" }}>
            <td colSpan={columns.length}></td>
          </tr>
        </>
      )}
    </>
  );
}

function LogTable({
  data,
}: {
  data: ProcessingStatus[] | { data: ProcessingStatus[] };
}) {
  const logs = Array.isArray(data) ? data : (data?.data ?? []);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    item_id: false,
    collection_name: false,
    json: false,
  });
  const [grouping, setGrouping] = useState<GroupingState>([]);
  const [sorting, setSorting] = useState([{ id: "timestamp", desc: true }]);
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: 25,
  });
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const columnHelper = createColumnHelper<ProcessingStatus>();

  const columns = useMemo(
    () => [
      columnHelper.accessor("timestamp", {
        header: "Time",
        cell: (info) => {
          const value = info.getValue<string | null | undefined>();
          if (typeof value === "string" && value.length > 0) {
            try {
              return format(parseISO(value), "yyyy-MM-dd HH:mm:ss");
            } catch (e) {
              console.error("Error parsing date string:", value, e);
              return "Invalid Date";
            }
          }
          return "-";
        },
        enableGrouping: false,
        aggregationFn: "count",
      }),
      columnHelper.accessor("collection_name", {
        header: "Collection",
        cell: (info) => info.getValue() || "",
        enableGrouping: true,
        aggregationFn: "count",
      }),
      columnHelper.accessor(
        (row) => row.event?.split(".").slice(0, -1).join(".") || "",
        {
          id: "prefix",
          header: "Prefix",
          enableGrouping: true,
          aggregationFn: "count",
        },
      ),
      columnHelper.accessor((row) => row.event?.split(".").pop() || "", {
        id: "status",
        header: "Status",
        cell: (info) => {
          const value = info.getValue<string | undefined>() ?? "";
          return <Badge color={getStatusColor(value)}>{value || "-"}</Badge>;
        },
        enableGrouping: true,
        aggregationFn: "count",
      }),
      columnHelper.accessor("item_id", {
        header: "Item ID",
        enableGrouping: false,
        aggregationFn: "count",
      }),
      columnHelper.accessor((row) => row.message ?? "", {
        id: "message",
        header: "Message",
        enableGrouping: false,
        aggregationFn: "count",
      }),
      columnHelper.accessor(
        (row) => (row.json ? JSON.stringify(row.json) : ""),
        {
          id: "json",
          header: "JSON",
          enableGrouping: false,
          aggregationFn: "count",
        },
      ),
      columnHelper.accessor(
        (row) => (row.duration_ms != null ? row.duration_ms / 1000 : null),
        {
          id: "duration_s",
          header: "Duration (s)",
          enableGrouping: false,
          aggregationFn: "sum",
          cell: (info) => {
            if (info.cell.getIsAggregated()) {
              const sum = info.getValue<number | null>();
              return sum != null ? `${sum.toFixed(2)}s (total)` : "-";
            }
            const value = info.getValue<number | null>();
            return value != null ? `${value.toFixed(2)}s` : "-";
          },
        },
      ),
    ],
    [columnHelper],
  );

  // Process logs data
  const processedLogs = useMemo(() => {
    try {
      // Extract source data
      const sourceData = Array.isArray(data) ? data : (data.data ?? []);

      // Ensure all items have unique IDs
      return sourceData.map((item, index) => {
        // Clone the item to avoid mutating the original
        const processedItem = { ...item };

        // Ensure ID exists
        if (!processedItem.id) {
          processedItem.id = `log_${index}_${Date.now()}`;
        }

        // Ensure any subRows also have IDs
        if (processedItem.subRows && Array.isArray(processedItem.subRows)) {
          processedItem.subRows = processedItem.subRows.map(
            (subItem, subIndex) => {
              return {
                ...subItem,
                id: subItem.id || `${processedItem.id}_sub_${subIndex}`,
              };
            },
          );
        }

        return processedItem;
      });
    } catch (e) {
      console.error("Error processing logs data:", e);
      return [];
    }
  }, [data]);

  const table = useReactTable({
    data: processedLogs,
    columns,
    state: {
      columnFilters,
      globalFilter,
      columnVisibility,
      grouping,
      pagination,
      sorting,
      expanded,
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onGroupingChange: setGrouping,
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSubRows: (row) => row.subRows,
    enableColumnFilters: true,
    enableGrouping: true,
    autoResetExpanded: false,
    enableExpanding: true,
    getRowId: (originalRow, index, parent) => {
      // Create a more unique identifier by combining multiple properties

      // Use the original ID if it exists
      const originalId =
        originalRow && typeof originalRow.id === "string"
          ? originalRow.id
          : `idx_${index}`;

      // For parent-child relationships, create a path-like ID structure
      if (parent) {
        // This ensures we have a unique hierarchy path for each row
        return `${parent.id}_${originalId}`;
      }

      // Add timestamp if available to further ensure uniqueness
      if (originalRow && originalRow.timestamp) {
        const timeComponent =
          typeof originalRow.timestamp === "string"
            ? originalRow.timestamp.replace(/[^0-9]/g, "").slice(-6)
            : "";
        return `${originalId}_${timeComponent}`;
      }

      // Fallback case with guaranteed uniqueness
      return `${originalId}_${Math.random().toString(36).substring(2, 9)}`;
    },
    debugTable: true,
  });

  useEffect(() => {
    if (grouping.length > 0) {
      setExpanded(true);
    } else {
      setExpanded({});
    }
  }, [grouping]);

  const handleToggleExpandAll = () => {
    if (table.getIsAllRowsExpanded()) {
      setExpanded({});
    } else {
      setExpanded(true);
    }
  };

  // Collect all row IDs to check for duplicates
  useEffect(() => {
    if (table.getRowModel().rows.length > 0) {
      const rowIds: Record<string, number> = {};
      const dupes: string[] = [];

      // Check all rows including nested subrows
      const checkRows = (rows: Row<ProcessingStatus>[]) => {
        rows.forEach((row) => {
          if (rowIds[row.id]) {
            rowIds[row.id]++;
            dupes.push(row.id);
          } else {
            rowIds[row.id] = 1;
          }

          // Recursively check subrows
          if (row.subRows && row.subRows.length > 0) {
            checkRows(row.subRows);
          }
        });
      };

      checkRows(table.getRowModel().rows);

      if (dupes.length > 0) {
        console.warn("[LogTable] Found duplicate row IDs:", dupes);
      }
    }
  }, [table.getRowModel().rows, grouping, expanded]);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <TextInput
          placeholder="Search logs..."
          value={globalFilter ?? ""}
          onChange={(e) => setGlobalFilter(e.target.value)}
          style={{ width: 300 }}
        />
        <Group>
          <Button
            size="md"
            color={grouping.length > 0 ? "red" : "blue"}
            variant="outline"
            onClick={() =>
              setGrouping((old) => (old.includes("prefix") ? [] : ["prefix"]))
            }
          >
            {grouping.includes("prefix")
              ? "Remove Grouping"
              : "Group by Prefix"}
          </Button>
        </Group>
        <Group>
          <Text size="sm">
            Page {pagination.pageIndex + 1} of {table.getPageCount()}
          </Text>
          <Select
            value={table.getState().pagination.pageSize.toString()}
            onChange={(value) => {
              if (value) table.setPageSize(Number(value));
            }}
            data={[25, 50, 100, 1000].map((pageSize) => ({
              value: pageSize.toString(),
              label: `Show ${pageSize}`,
            }))}
          />
        </Group>
      </Group>

      <Group gap="xs" align="center">
        <Text size="sm" fw={500}>
          Filters:
        </Text>
        <Group>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setColumnFilters([
                {
                  id: "status",
                  value: "failed",
                },
              ])
            }
          >
            Show Failed
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setColumnFilters([
                {
                  id: "status",
                  value: "completed",
                },
              ])
            }
          >
            Show Completed
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setColumnFilters([
                {
                  id: "status",
                  value: "error",
                },
              ])
            }
          >
            Show Errors
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setColumnFilters([])}
            disabled={columnFilters.length === 0}
          >
            Clear Filters
          </Button>
          {grouping.length > 0 && (
            <Button size="xs" variant="outline" onClick={handleToggleExpandAll}>
              {table.getIsAllRowsExpanded() ? "Collapse All" : "Expand All"}
            </Button>
          )}
        </Group>
      </Group>

      <Group gap="xs">
        <Text size="sm" fw={500}>
          Columns:
        </Text>
        {table.getAllLeafColumns().map((column) => (
          <Checkbox
            key={column.id}
            label={column.id}
            checked={column.getIsVisible()}
            onChange={column.getToggleVisibilityHandler()}
          />
        ))}
      </Group>

      <ScrollArea>
        <Table striped highlightOnHover>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      cursor: header.column.getCanSort()
                        ? "pointer"
                        : "default",
                      background: header.column.getIsGrouped()
                        ? "#f0f8ff"
                        : undefined,
                    }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                    {header.column.getCanSort() && (
                      <span>
                        {{
                          asc: " 🔼",
                          desc: " 🔽",
                        }[header.column.getIsSorted() as string] ?? " ⏺️"}
                      </span>
                    )}
                    {header.column.getCanGroup() && (
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={(e) => {
                          e.stopPropagation();
                          header.column.getToggleGroupingHandler()();
                        }}
                        style={{ marginLeft: "0.5rem" }}
                      >
                        {header.column.getIsGrouped() ? "🔴" : "⚪️"}
                      </Button>
                    )}
                    {header.column.getCanFilter() ? (
                      <div>
                        <TextInput
                          size="xs"
                          placeholder={`Filter ${header.column.id}...`}
                          value={
                            (header.column.getFilterValue() as string) ?? ""
                          }
                          onChange={(e) =>
                            header.column.setFilterValue(e.target.value)
                          }
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    ) : null}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {/* Create a recursive row renderer to handle parent and child rows */}
            {table.getRowModel().rows.map((row) => (
              <TableRowRenderer
                key={row.id}
                row={row}
                flexRender={flexRender}
                columns={columns}
              />
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: "center" }}>
                  No results found
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </ScrollArea>

      <Group gap="xs">
        <Button
          size="xs"
          variant="outline"
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
        >
          {"<<"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          {"<"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          {">"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => table.setPageIndex(table.getPageCount() - 1)}
          disabled={!table.getCanNextPage()}
        >
          {">>"}
        </Button>
      </Group>
    </Stack>
  );
}

export default function DebugPage() {
  const ref = useRef<number>(0);
  const handleTestToast = () => {
    if (ref.current === 0) {
      toast.success("Test toast");
    } else if (ref.current === 1) {
      toast.error("Test toast");
    } else if (ref.current === 2) {
      toast.warning("Test toast");
    } else if (ref.current === 3) {
      toast.info("Test toast");
    } else if (ref.current === 4) {
      toast.error("Test toast");
    } else {
      toast("Test toast");
    }

    ref.current++;
  };

  const { projectId, conversationId, chatId } = useParams();

  const [currentProjectId, setCurrentProjectId] = useState<string | null>(
    projectId ?? null,
  );
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(conversationId ?? null);

  const [currentChatId, setCurrentChatId] = useState<string | null>(
    chatId ?? null,
  );

  const { data: user } = useCurrentUser();

  const { data: project } = useProjectById({ projectId: currentProjectId! });

  const { data: conversation } = useConversationById({
    conversationId: currentConversationId!,
    loadConversationChunks: true,
  });

  const { data: chats } = useProjectChats(currentProjectId!, {
    filter: {
      project_id: {
        _eq: currentProjectId,
      },
      "count(project_chat_messages)": {
        // @ts-ignore
        _gt: 0,
      },
    },
  });

  const {
    data: conversationProcessingStatus,
    refetch: refetchConversationProcessingStatus,
  } = useProcessingStatus({
    collectionName: "conversation",
    itemId: currentConversationId!,
  });

  const variables = {
    DEBUG_MODE: true,
    BUILD_VERSION,
    ff: {
      ENABLE_CHAT_AUTO_SELECT,
      SUPPORTED_LANGUAGES,
    },
    urls: {
      API_BASE_URL,
      DIRECTUS_PUBLIC_URL,
      DIRECTUS_CONTENT_PUBLIC_URL,
      ADMIN_BASE_URL,
      PARTICIPANT_BASE_URL,
    },
  };

  return (
    <Stack className="p-8">
      <Stack>
        <Title order={1}>Debug</Title>
        <Group>
          <TextInput
            label="Project ID"
            value={currentProjectId ?? ""}
            onChange={(e) => setCurrentProjectId(e.target.value)}
          />
          <TextInput
            label="Conversation ID"
            value={currentConversationId ?? ""}
            onChange={(e) => setCurrentConversationId(e.target.value)}
          />
          <TextInput
            label="Chat ID"
            value={currentChatId ?? ""}
            onChange={(e) => setCurrentChatId(e.target.value)}
          />
        </Group>
        <Stack>
          <pre>{JSON.stringify(variables, null, 2)}</pre>
        </Stack>
        <div>
          <Button onClick={handleTestToast}>Test Toast</Button>
        </div>
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>User</Title>
        <pre>{JSON.stringify(user, null, 2)}</pre>
      </Stack>
      <Stack>
        <Title order={1}>Project</Title>
        <pre>{JSON.stringify(project, null, 2)}</pre>
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>Conversation</Title>
        <pre>{JSON.stringify(conversation, null, 2)}</pre>
        <Divider />
        <Group>
          <Title order={3}>Logs</Title>
          <Button onClick={() => refetchConversationProcessingStatus()}>
            Refetch Logs
          </Button>
        </Group>
        <LogTable data={conversationProcessingStatus ?? []} />
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>Chats</Title>
        <pre>{JSON.stringify(chats, null, 2)}</pre>
      </Stack>
    </Stack>
  );
}

