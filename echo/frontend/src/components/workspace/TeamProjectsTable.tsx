import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Menu,
	Paper,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconDots, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useUrlSearch } from "@/hooks/useUrlSearch";

interface OrgProject {
	id: string;
	name: string;
	workspace_id: string;
	workspace_name: string;
	visibility: string;
	conversation_count: number;
	created_at: string | null;
}

async function fetchOrgProjects(orgId: string): Promise<OrgProject[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/projects`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

async function deleteProject(projectId: string) {
	// v1 endpoint; soft-deletes via deleted_at.
	const res = await fetch(`${API_BASE_URL}/projects/${projectId}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Couldn't delete",
		);
	}
	return res.json().catch(() => ({}));
}

function formatDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Team-wide projects view (matrix §4 delete-workspace workflow).
 *
 * Team admins can scan every project across every team workspace and
 * soft-delete from one surface. Prereq for winding down a workspace:
 * delete-workspace is blocked while any project exists, and admins
 * don't want to walk into 20 workspaces one by one.
 *
 * Filter + search are client-side — volume is small enough to render
 * everything.
 */
export const TeamProjectsTable = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const [search, setSearch] = useUrlSearch();
	const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);

	const { data: projects = [], isLoading } = useQuery({
		queryKey: ["v2", "org", orgId, "projects"],
		queryFn: () => fetchOrgProjects(orgId),
		staleTime: 30_000,
	});

	const workspaceOptions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const p of projects) {
			if (!seen.has(p.workspace_id)) {
				seen.set(p.workspace_id, p.workspace_name);
			}
		}
		return Array.from(seen.entries()).map(([value, label]) => ({
			value,
			label,
		}));
	}, [projects]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		// Sort by conversation_count desc so busiest projects are on top
		// — matches the demo feedback "sort it by the most highest
		// conversations project."
		return projects
			.filter((p) => {
				if (workspaceFilter && p.workspace_id !== workspaceFilter)
					return false;
				if (!q) return true;
				return (
					p.name.toLowerCase().includes(q) ||
					p.workspace_name.toLowerCase().includes(q)
				);
			})
			.slice()
			.sort((a, b) => b.conversation_count - a.conversation_count);
	}, [projects, search, workspaceFilter]);

	const deleteMutation = useMutation({
		mutationFn: deleteProject,
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "org", orgId, "projects"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "org-usage", orgId],
			});
			toast.success(t`Project deleted`);
		},
		onError: (e: Error) => toast.error(e.message),
	});

	const handleDelete = (p: OrgProject) => {
		modals.openConfirmModal({
			title: t`Delete ${p.name}?`,
			children: (
				<Stack gap={8}>
					<Text size="sm">
						<Trans>
							Delete this project in {p.workspace_name}? Conversations
							and data stay recoverable for 30 days, then are permanently
							removed.
						</Trans>
					</Text>
					{p.conversation_count > 0 && (
						<Text size="sm" c="dimmed">
							<Plural
								value={p.conversation_count}
								one="# conversation will be hidden along with it."
								other="# conversations will be hidden along with it."
							/>
						</Text>
					)}
				</Stack>
			),
			labels: { confirm: t`Delete`, cancel: t`Cancel` },
			confirmProps: { color: "red" },
			onConfirm: () => deleteMutation.mutate(p.id),
		});
	};

	if (isLoading) return null;

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap={12}>
				<Group justify="space-between" wrap="wrap">
					<Text size="xs" fw={500} tt="uppercase" c="dimmed" lts={0.5}>
						<Trans>Projects across team · {projects.length}</Trans>
					</Text>
					<Group gap="xs">
						<TextInput
							leftSection={<IconSearch size={14} />}
							placeholder={t`Search project or workspace`}
							size="xs"
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
							style={{ minWidth: 220 }}
						/>
						<Select
							size="xs"
							placeholder={t`All workspaces`}
							data={workspaceOptions}
							value={workspaceFilter}
							onChange={setWorkspaceFilter}
							clearable
							style={{ minWidth: 180 }}
						/>
					</Group>
				</Group>

				{filtered.length === 0 ? (
					<Text size="sm" c="dimmed">
						<Trans>No projects match.</Trans>
					</Text>
				) : (
					<Table verticalSpacing="xs" striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Project</Trans>
									</Text>
								</Table.Th>
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Workspace</Trans>
									</Text>
								</Table.Th>
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Conversations</Trans>
									</Text>
								</Table.Th>
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Created</Trans>
									</Text>
								</Table.Th>
								<Table.Th style={{ width: 48 }}></Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{filtered.map((p) => (
								<Table.Tr key={p.id}>
									<Table.Td>
										<Group gap={6} wrap="nowrap">
											<Text size="sm" truncate>
												{p.name || t`Untitled`}
											</Text>
											{p.visibility === "private" && (
												<Badge size="xs" color="gray" variant="light">
													<Trans>Private</Trans>
												</Badge>
											)}
										</Group>
									</Table.Td>
									<Table.Td>
										<Text size="xs" c="dimmed" truncate>
											{p.workspace_name}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{p.conversation_count}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs" c="dimmed">
											{formatDate(p.created_at)}
										</Text>
									</Table.Td>
									<Table.Td>
										{/* Destructive action hides behind a row menu
										    so a dense table of rows doesn't offer
										    click-to-delete as the easiest gesture. */}
										<Menu shadow="md" width={160} position="bottom-end">
											<Menu.Target>
												<ActionIcon
													size="sm"
													variant="subtle"
													color="gray"
													loading={
														deleteMutation.isPending &&
														deleteMutation.variables === p.id
													}
													aria-label={t`Project actions`}
												>
													<IconDots size={14} />
												</ActionIcon>
											</Menu.Target>
											<Menu.Dropdown>
												<Menu.Item
													color="red"
													leftSection={<IconTrash size={14} />}
													onClick={() => handleDelete(p)}
												>
													<Trans>Delete…</Trans>
												</Menu.Item>
											</Menu.Dropdown>
										</Menu>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				)}
			</Stack>
		</Paper>
	);
};
