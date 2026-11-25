import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Menu,
	Table,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { InfoTip } from "@/components/common/InfoTip";
import { I18nLink } from "@/components/common/i18nLink";
import { formatTimestamp } from "@/components/map/panels/shared";
import { SupportRequestNoteModal } from "@/components/workspace/SupportRequestNoteModal";
import {
	orgWorkspacesKey,
	type SupportVisitStatus,
	useSupportVisitActions,
} from "@/components/workspace/supportVisit";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { formatDate } from "../format";
import { Section } from "../ui";

/** One workspace of the organisation, with the caller's own visit and waiting request. */
export type OrgWorkspace = {
	workspace_id: string;
	name: string;
	support_access_enabled: boolean;
	held_for_demo: boolean;
	visit: SupportVisitStatus;
	request: {
		id: string;
		created_at: string | null;
		expires_at: string | null;
	} | null;
};

/**
 * Staff: getting into one of the organisation's workspaces to help, one row per workspace.
 * Each row says what access the staff member has there and offers the likely next step,
 * the rest under its menu, as Documents does. The whole list is one read.
 */
export function SupportAccess({ orgId }: { orgId: string }) {
	const { data, isLoading, isError } = useQuery({
		queryFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/orgs/${orgId}/workspaces`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			return res.json() as Promise<{ workspaces: OrgWorkspace[] }>;
		},
		queryKey: orgWorkspacesKey(orgId),
	});
	const workspaces = data?.workspaces ?? [];

	return (
		<Section
			title={<Trans>Support access</Trans>}
			testId="staff-support-access"
			info={
				<InfoTip label={t`About support access`} testId="staff-support-info">
					<Trans>
						Ask a workspace's admins to let you in. If they approve your
						request, you can edit for 24 hours. If they have turned support
						access on themselves, you can join to read, and still ask to edit.
					</Trans>
				</InfoTip>
			}
		>
			{isLoading ? null : isError ? (
				<Text size="sm" c="dimmed">
					<Trans>The workspaces could not be loaded.</Trans>
				</Text>
			) : workspaces.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No workspaces.</Trans>
				</Text>
			) : (
				// The grid of Tasks above (Status 150, actions 190 from sm), the actions split
				// into the next step and the menu slot that Documents keeps at the right edge.
				<Table verticalSpacing="xs" layout="fixed">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Workspace</Trans>
							</Table.Th>
							<Table.Th w={150} visibleFrom="sm">
								<Trans>Status</Trans>
							</Table.Th>
							<Table.Th w={{ base: 136, sm: 146 }} />
							<Table.Th w={44} />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{workspaces.map((ws) => (
							<VisitRow key={ws.workspace_id} ws={ws} />
						))}
					</Table.Tbody>
				</Table>
			)}
		</Section>
	);
}

/** A step a row offers: the button in the row, or an item under its menu. */
type Step = {
	label: ReactNode;
	testId: string;
	onClick?: () => void;
	/** Opens this address instead. */
	to?: string;
	/** The quiet button, for taking back what was asked. */
	quiet?: boolean;
	loading?: boolean;
};

/**
 * What the badge says, and its tint: green while the staff member is in the workspace,
 * blue while their request waits on the admins (as a sent offer waits on its signer on
 * this page), grey otherwise.
 */
type Status = { label: ReactNode; color: "green" | "blue" | "gray" };

/** One workspace: name, the line under it, its badge, the next step and the rest. */
function Row({
	name,
	detail,
	status,
	next,
	more = [],
	disabled = false,
	state,
}: {
	name: string;
	detail?: string;
	status: Status;
	next?: Step;
	more?: Step[];
	disabled?: boolean;
	state: string;
}) {
	return (
		<Table.Tr data-testid="staff-support-workspace" data-state={state}>
			<Table.Td>
				<Text size="sm" truncate>
					{name}
				</Text>
				{/* The line wraps rather than truncates: cut short on a phone it loses the time. */}
				{detail && (
					<Text size="xs" c="dimmed" data-testid="staff-support-detail">
						{detail}
					</Text>
				)}
				{/* On a phone the status sits under the name. */}
				<Badge
					hiddenFrom="sm"
					size="xs"
					variant="light"
					color={status.color}
					mt="xs"
				>
					{status.label}
				</Badge>
			</Table.Td>
			<Table.Td visibleFrom="sm">
				<Badge
					size="sm"
					variant="light"
					color={status.color}
					data-testid="staff-support-status"
				>
					{status.label}
				</Badge>
			</Table.Td>
			<Table.Td ta="right">
				{next?.to ? (
					<Button
						size="compact-xs"
						variant="default"
						component={I18nLink}
						to={next.to}
						onClick={next.onClick}
						data-testid={next.testId}
					>
						{next.label}
					</Button>
				) : next ? (
					<Button
						size="compact-xs"
						variant={next.quiet ? "subtle" : "default"}
						color={next.quiet ? "gray" : undefined}
						loading={next.loading}
						disabled={disabled}
						onClick={next.onClick}
						data-testid={next.testId}
					>
						{next.label}
					</Button>
				) : null}
			</Table.Td>
			<Table.Td>
				{more.length > 0 && (
					<Menu position="bottom-end" withinPortal>
						<Menu.Target>
							<UnstyledButton
								aria-label={t`Actions`}
								p={4}
								data-testid="staff-support-menu"
							>
								<DotsThreeIcon size={20} />
							</UnstyledButton>
						</Menu.Target>
						<Menu.Dropdown>
							{more.map((step) => (
								<Menu.Item
									key={step.testId}
									disabled={disabled}
									onClick={step.onClick}
									data-testid={step.testId}
								>
									{step.label}
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
				)}
			</Table.Td>
		</Table.Tr>
	);
}

/** One workspace's row, from the list's own data; the steps change it through the actions. */
export function VisitRow({ ws }: { ws: OrgWorkspace }) {
	const { i18n } = useLingui();
	const { setWorkspace } = useWorkspace();
	const actions = useSupportVisitActions(ws.workspace_id);
	const [noteOpen, setNoteOpen] = useState(false);
	const on = ws.support_access_enabled;
	const { visit, request: waiting } = ws;

	const join: Step = {
		label: <Trans>Join read-only</Trans>,
		loading: actions.join.isPending,
		onClick: () => actions.join.mutate(),
		testId: "staff-support-join",
	};
	const extend: Step = {
		label: <Trans>Extend visit by 24 hours</Trans>,
		onClick: () => actions.join.mutate(),
		testId: "staff-support-extend",
	};
	const leave: Step = {
		label: <Trans>End visit now</Trans>,
		onClick: () => actions.leave.mutate(),
		testId: "staff-support-leave",
	};
	const open: Step = {
		label: <Trans context="verb">Open</Trans>,
		onClick: () => setWorkspace(ws.workspace_id),
		testId: "staff-support-open",
		to: `/w/${ws.workspace_id}/home`,
	};
	const request: Step = {
		label: <Trans>Request access</Trans>,
		onClick: () => setNoteOpen(true),
		testId: "staff-support-request",
	};
	// With read access already on, what a request adds is the right to edit, so it says so.
	const askToEdit: Step = {
		...request,
		label: <Trans>Ask to edit</Trans>,
	};
	const cancel: Step = {
		label: <Trans>Cancel request</Trans>,
		loading: actions.cancelRequest.isPending,
		onClick: () => actions.cancelRequest.mutate(),
		quiet: true,
		testId: "staff-support-cancel",
	};

	const row = ((): {
		state: string;
		status: Status;
		detail?: string;
		next?: Step;
		more?: Step[];
	} => {
		if (ws.held_for_demo)
			return {
				state: "demo",
				status: { color: "gray", label: <Trans>Demo draft</Trans> },
			};
		if (visit.active) {
			// Extending needs the switch on, as joining does.
			const extendLeave = on ? [extend, leave] : [leave];
			if (visit.can_change) {
				// A visit ends within a day or two, so the time goes without the year.
				const until = formatTimestamp(
					visit.change_until ?? visit.expires_at,
					i18n.locale,
				);
				return {
					detail: t`Until ${until}`,
					more: extendLeave,
					next: open,
					state: "change",
					status: { color: "green", label: <Trans>Can edit</Trans> },
				};
			}
			// A read-only visit can still ask the admins to let it edit.
			const until = formatTimestamp(visit.expires_at, i18n.locale);
			return {
				detail: waiting
					? t`Until ${until}. Request to edit sent`
					: t`Until ${until}`,
				more: [waiting ? cancel : askToEdit, ...extendLeave],
				next: open,
				state: "read",
				status: { color: "green", label: <Trans>Read only</Trans> },
			};
		}
		if (waiting) {
			const date = formatDate(waiting.expires_at, i18n.locale);
			return {
				detail: date ? t`Expires ${date}` : undefined,
				more: on ? [join] : [],
				next: cancel,
				state: "request",
				status: { color: "blue", label: <Trans>Request sent</Trans> },
			};
		}
		if (on)
			return {
				more: [askToEdit],
				next: join,
				state: "on",
				status: { color: "gray", label: <Trans>Read access on</Trans> },
			};
		return {
			next: request,
			state: "none",
			status: { color: "gray", label: <Trans>No access</Trans> },
		};
	})();

	return (
		<>
			<Row name={ws.name} disabled={actions.busy} {...row} />
			<SupportRequestNoteModal
				opened={noteOpen}
				onClose={() => setNoteOpen(false)}
				visit={actions}
				workspaceName={ws.name}
			/>
		</>
	);
}
