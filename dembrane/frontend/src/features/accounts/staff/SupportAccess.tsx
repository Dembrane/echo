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
import { SupportRequestNoteModal } from "@/components/workspace/SupportRequestNoteModal";
import { useSupportVisit } from "@/components/workspace/supportVisit";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { formatDate, formatDateTime } from "../format";
import { Section } from "../ui";

export type OrgWorkspace = {
	workspace_id: string;
	name: string;
	support_access_enabled: boolean;
	held_for_demo: boolean;
};

export const orgWorkspacesKey = (orgId: string) =>
	["v2", "admin", "org-workspaces", orgId] as const;

/**
 * Staff: getting into one of the organisation's workspaces to help, one row per workspace.
 * Each row shows where the visit stands (read only, or able to make changes) and offers the
 * likely next step, the rest under its menu, as Documents does.
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
						Ask a workspace's admins to let you in. When they approve your
						request you can make changes for 24 hours. When they turned support
						access on themselves, you can join to read, and still ask for more.
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
				<Table verticalSpacing="xs" layout="fixed">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Workspace</Trans>
							</Table.Th>
							<Table.Th w={180} visibleFrom="sm">
								<Trans>Status</Trans>
							</Table.Th>
							<Table.Th w={250} visibleFrom="md" />
							<Table.Th w={44} />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{workspaces.map((ws) =>
							ws.held_for_demo ? (
								<Row
									key={ws.workspace_id}
									name={ws.name}
									status={<Trans>Demo not published</Trans>}
									state="demo"
								/>
							) : (
								<VisitRow key={ws.workspace_id} ws={ws} />
							),
						)}
					</Table.Tbody>
				</Table>
			)}
		</Section>
	);
}

/** A step a row offers: a button, or an item under the row's menu. */
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
 * One workspace: its name and detail, its status, the next step and the rest under the
 * menu. Below the two-column card the next step joins the menu, so a long label (Dutch
 * "Join for support" is 245px) never pushes the name off.
 */
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
	status?: ReactNode;
	next?: Step;
	more?: Step[];
	disabled?: boolean;
	state: string;
}) {
	const item = (step: Step, narrowOnly = false) => {
		const props = {
			disabled,
			hiddenFrom: narrowOnly ? "md" : undefined,
			onClick: step.onClick,
		};
		return step.to ? (
			<Menu.Item key={step.testId} component={I18nLink} to={step.to} {...props}>
				{step.label}
			</Menu.Item>
		) : (
			<Menu.Item key={step.testId} {...props}>
				{step.label}
			</Menu.Item>
		);
	};
	return (
		<Table.Tr data-testid="staff-support-workspace" data-state={state}>
			<Table.Td>
				<Text size="sm" truncate>
					{name}
				</Text>
				{detail && (
					<Text size="xs" c="dimmed" truncate>
						{detail}
					</Text>
				)}
				{/* On a phone the status sits under the name. */}
				{status && (
					<Badge hiddenFrom="sm" size="xs" variant="light" color="gray" mt="xs">
						{status}
					</Badge>
				)}
			</Table.Td>
			<Table.Td visibleFrom="sm">
				{status && (
					<Badge size="sm" variant="light" color="gray">
						{status}
					</Badge>
				)}
			</Table.Td>
			<Table.Td ta="right" visibleFrom="md">
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
				{(next || more.length > 0) && (
					<Menu position="bottom-end" withinPortal>
						<Menu.Target>
							<UnstyledButton
								aria-label={t`Actions`}
								p={4}
								hiddenFrom={more.length ? undefined : "md"}
								data-testid="staff-support-menu"
							>
								<DotsThreeIcon size={20} />
							</UnstyledButton>
						</Menu.Target>
						<Menu.Dropdown>
							{next && item(next, true)}
							{more.map((step) => item(step))}
						</Menu.Dropdown>
					</Menu>
				)}
			</Table.Td>
		</Table.Tr>
	);
}

function VisitRow({ ws }: { ws: OrgWorkspace }) {
	const { i18n } = useLingui();
	const { setWorkspace } = useWorkspace();
	const visit = useSupportVisit(ws.workspace_id);
	const [noteOpen, setNoteOpen] = useState(false);
	const on = ws.support_access_enabled;
	const { pendingRequest } = visit;

	const join: Step = {
		label: <Trans>Join for support (24h)</Trans>,
		loading: visit.join.isPending,
		onClick: () => visit.join.mutate(),
		testId: "staff-support-join",
	};
	const extend: Step = {
		label: <Trans>Extend 24h</Trans>,
		onClick: () => visit.join.mutate(),
		testId: "staff-support-extend",
	};
	const leave: Step = {
		label: <Trans>Leave now</Trans>,
		onClick: () => visit.leave.mutate(),
		testId: "staff-support-leave",
	};
	const open: Step = {
		label: <Trans>Open workspace</Trans>,
		onClick: () => setWorkspace(ws.workspace_id),
		testId: "staff-support-open",
		to: `/w/${ws.workspace_id}/home`,
	};
	const request: Step = {
		label: <Trans>Request access</Trans>,
		onClick: () => setNoteOpen(true),
		testId: "staff-support-request",
	};
	const cancel: Step = {
		label: <Trans>Cancel request</Trans>,
		loading: visit.cancelRequest.isPending,
		onClick: () => visit.cancelRequest.mutate(),
		quiet: true,
		testId: "staff-support-cancel",
	};

	const row = (() => {
		if (visit.loading) return { state: "loading" };
		if (visit.active) {
			const until = formatDateTime(visit.expiresAt, i18n.locale);
			const extendLeave = on ? [extend, leave] : [leave];
			if (visit.canChange)
				return {
					detail: t`Until ${until}`,
					more: extendLeave,
					next: open,
					state: "change",
					status: <Trans>Can make changes</Trans>,
				};
			// A read-only visit can still ask the admins to let it make changes.
			return {
				detail: pendingRequest
					? t`Until ${until}. Request sent`
					: t`Until ${until}`,
				more: [pendingRequest ? cancel : request, ...extendLeave],
				next: open,
				state: "read",
				status: <Trans>Read only</Trans>,
			};
		}
		if (pendingRequest) {
			const sent = formatDate(pendingRequest.created_at, i18n.locale);
			return {
				detail: sent ? t`Sent ${sent}` : undefined,
				more: on ? [join] : [],
				next: cancel,
				state: "request",
				status: <Trans>Request sent</Trans>,
			};
		}
		if (on)
			return {
				more: [request],
				next: join,
				state: "on",
				status: <Trans>Support access is on</Trans>,
			};
		return { next: request, state: "none" };
	})();

	return (
		<>
			<Row name={ws.name} disabled={visit.busy} {...row} />
			<SupportRequestNoteModal
				opened={noteOpen}
				onClose={() => setNoteOpen(false)}
				visit={visit}
			/>
		</>
	);
}
