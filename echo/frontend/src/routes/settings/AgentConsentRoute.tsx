import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
	Card,
	Checkbox,
	Container,
	Group,
	List,
	Loader,
	Select,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconInfoCircle } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { AgentRiskNotice } from "@/components/agent-access/AgentRiskNotice";
import { scopeLabel } from "@/components/agent-access/format";
import {
	AgentAccessError,
	type OrgAgentAccess,
	useAgentAuthorizeRequestQuery,
	useApproveAuthorizeRequestMutation,
	useDenyAuthorizeRequestMutation,
	useSetOrgAgentAccessMutation,
} from "@/components/agent-access/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const DEFAULT_EXPIRY_DAYS = 90;

// Write is off unless the user ticks it: reading is what people come for,
// changing settings is the part they should opt into on purpose.
export const grantedScopes = ({
	requestedScopes,
	allowWrite,
}: {
	requestedScopes: string[];
	allowWrite: boolean;
}) =>
	requestedScopes.includes("write") && allowWrite
		? ["read", "write"]
		: ["read"];

// Pure so the test can pin it: Allow needs the checkbox and at least one org.
export const canAllow = ({
	consentAccepted,
	selectedOrgIds,
}: {
	consentAccepted: boolean;
	selectedOrgIds: string[];
}) => consentAccepted && selectedOrgIds.length > 0;

const OrgChoice = ({
	org,
	checked,
	onChange,
}: {
	org: OrgAgentAccess;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) => {
	const enable = useSetOrgAgentAccessMutation();
	const selectable = org.agent_access_enabled;
	return (
		<Group
			justify="space-between"
			align="center"
			wrap="nowrap"
			data-testid={`consent-org-${org.id}`}
		>
			<Checkbox
				checked={selectable && checked}
				disabled={!selectable}
				onChange={(e) => onChange(e.currentTarget.checked)}
				label={org.name}
				description={
					selectable ? undefined : t`Not enabled by an admin of ${org.name}`
				}
				data-testid={`consent-org-checkbox-${org.id}`}
			/>
			{!selectable && org.can_manage && (
				<Button
					size="xs"
					variant="outline"
					loading={enable.isPending}
					onClick={() => enable.mutate({ enabled: true, orgId: org.id })}
					data-testid={`consent-org-enable-${org.id}`}
				>
					<Trans>Enable</Trans>
				</Button>
			)}
		</Group>
	);
};

export const AgentConsentRoute = () => {
	useDocumentTitle(t`MCP access | dembrane`);
	const [searchParams] = useSearchParams();
	const navigate = useI18nNavigate();
	const requestId = searchParams.get("request");

	const { data, isLoading, error } = useAgentAuthorizeRequestQuery(requestId);
	const approve = useApproveAuthorizeRequestMutation();
	const deny = useDenyAuthorizeRequestMutation();

	const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([]);
	const [expiresInDays, setExpiresInDays] =
		useState<number>(DEFAULT_EXPIRY_DAYS);
	const [consentAccepted, setConsentAccepted] = useState(false);
	const [allowWrite, setAllowWrite] = useState(false);

	// Preselect the one enabled org when there is exactly one; more than one
	// is a real choice the user should make. Once only: unticking it must
	// stick, or the user can never clear the selection.
	const enabledOrgs = useMemo(
		() => (data?.organisations ?? []).filter((o) => o.agent_access_enabled),
		[data],
	);
	const preselected = useRef(false);
	useEffect(() => {
		if (preselected.current || !data) return;
		preselected.current = true;
		if (enabledOrgs.length === 1) setSelectedOrgIds([enabledOrgs[0].id]);
	}, [data, enabledOrgs]);

	// An admin can flip an org off in another tab while this page is open;
	// drop it from the selection so Allow never names an org that is off.
	useEffect(() => {
		const enabledIds = new Set(enabledOrgs.map((o) => o.id));
		setSelectedOrgIds((ids) => {
			const kept = ids.filter((id) => enabledIds.has(id));
			return kept.length === ids.length ? ids : kept;
		});
	}, [enabledOrgs]);

	useEffect(() => {
		if (!data) return;
		if (!data.expiry_choices_days.includes(expiresInDays)) {
			setExpiresInDays(
				data.expiry_choices_days.includes(DEFAULT_EXPIRY_DAYS)
					? DEFAULT_EXPIRY_DAYS
					: (data.expiry_choices_days[0] ?? DEFAULT_EXPIRY_DAYS),
			);
		}
	}, [data, expiresInDays]);

	const allowEnabled = canAllow({ consentAccepted, selectedOrgIds });
	const busy = approve.isPending || deny.isPending;

	const onAllow = () => {
		if (!data || !allowEnabled) return;
		const scopes = grantedScopes({
			allowWrite,
			requestedScopes: data.requested_scopes,
		});
		approve.mutate(
			{
				expiresInDays,
				orgIds: selectedOrgIds,
				requestId: data.request_id,
				scopes,
			},
			{
				onSuccess: ({ redirect_url }) => {
					posthog.capture("agent_consent_approved", {
						client_id: data.client_id,
						expires_in_days: expiresInDays,
						org_count: selectedOrgIds.length,
						scopes,
					});
					window.location.assign(redirect_url);
				},
			},
		);
	};

	const onDeny = () => {
		if (!data) return;
		deny.mutate(
			{ requestId: data.request_id },
			{
				onSuccess: ({ redirect_url }) => {
					posthog.capture("agent_consent_denied", {
						client_id: data.client_id,
					});
					window.location.assign(redirect_url);
				},
			},
		);
	};

	const expired =
		!requestId || (error instanceof AgentAccessError && error.status === 404);

	return (
		<Container size="sm" px="lg" py="xl">
			<Card withBorder p="xl" radius="md" data-testid="agent-consent-card">
				{isLoading ? (
					<Group justify="center" py="xl">
						<Loader size="sm" color="gray" />
					</Group>
				) : expired || !data ? (
					<Stack gap="md">
						<Title order={3}>
							<Trans>This request has expired</Trans>
						</Title>
						<Text size="sm">
							<Trans>
								Start again from your agent. It will open a fresh request here.
							</Trans>
						</Text>
						{error && !expired && (
							<Alert color="red" variant="light">
								{error.message}
							</Alert>
						)}
						<Group>
							<Button
								variant="subtle"
								onClick={() => navigate("/connect-agent")}
							>
								<Trans>Back to settings</Trans>
							</Button>
						</Group>
					</Stack>
				) : (
					<Stack gap="lg">
						<Stack gap={4}>
							<Title order={3} data-testid="agent-consent-title">
								<Trans>{data.client_name} wants MCP access to dembrane</Trans>
							</Title>
							<Text size="sm" c="dimmed">
								<Trans>It will send you back to {data.redirect_host}.</Trans>
							</Text>
						</Stack>

						<Stack gap={4}>
							<Text size="sm" fw={500}>
								<Trans>It is asking to</Trans>
							</Text>
							<List size="sm" spacing={2}>
								{data.requested_scopes
									.filter((scope) => scope !== "write")
									.map((scope) => (
										<List.Item key={scope}>{scopeLabel(scope)}</List.Item>
									))}
							</List>
							{data.requested_scopes.includes("write") && (
								<Checkbox
									mt={4}
									checked={allowWrite}
									onChange={(e) => setAllowWrite(e.currentTarget.checked)}
									label={t`Also allow it to change project settings`}
									data-testid="agent-consent-write"
								/>
							)}
						</Stack>

						<Stack gap="xs">
							<Text size="sm" fw={500}>
								<Trans>In which organisations</Trans>
							</Text>
							{data.organisations.length === 0 ? (
								<Alert
									color="orange"
									variant="light"
									icon={<IconInfoCircle size={18} />}
								>
									<Trans>
										You are not a member of any organisation, so there is
										nothing to connect yet.
									</Trans>
								</Alert>
							) : (
								data.organisations.map((org) => (
									<OrgChoice
										key={org.id}
										org={org}
										checked={selectedOrgIds.includes(org.id)}
										onChange={(checked) =>
											setSelectedOrgIds((ids) =>
												checked
													? Array.from(new Set([...ids, org.id]))
													: ids.filter((id) => id !== org.id),
											)
										}
									/>
								))
							)}
						</Stack>

						<Select
							label={t`Access expires after`}
							value={String(expiresInDays)}
							onChange={(value) => {
								if (value) setExpiresInDays(Number(value));
							}}
							data={data.expiry_choices_days.map((days) => ({
								label: t`${days} days`,
								value: String(days),
							}))}
							allowDeselect={false}
							data-testid="agent-consent-expiry"
						/>

						<AgentRiskNotice clientName={data.client_name} />

						<Checkbox
							checked={consentAccepted}
							onChange={(e) => setConsentAccepted(e.currentTarget.checked)}
							label={t`I understand that ${data.client_name} and its provider will receive this data`}
							data-testid="agent-consent-accept"
						/>

						<Group justify="space-between" align="center">
							<Text size="xs" c="dimmed">
								<Trans>
									You can revoke this later under{" "}
									<Anchor size="xs" onClick={() => navigate("/connect-agent")}>
										Help, Connect your agent
									</Anchor>
									.
								</Trans>
							</Text>
							<Group gap="sm">
								<Button
									variant="subtle"
									onClick={onDeny}
									loading={deny.isPending}
									disabled={approve.isPending}
									data-testid="agent-consent-deny"
								>
									<Trans>Deny</Trans>
								</Button>
								<Button
									onClick={onAllow}
									loading={approve.isPending}
									disabled={!allowEnabled || busy}
									data-testid="agent-consent-allow"
								>
									<Trans>Allow</Trans>
								</Button>
							</Group>
						</Group>
					</Stack>
				)}
			</Card>
		</Container>
	);
};
