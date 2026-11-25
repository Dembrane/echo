import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Group,
	Modal,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type AiHistoryLine,
	type AiProvider,
	aiRequest,
	formatDay,
	providerName,
} from "@/components/ai-provider/hooks";
import {
	ProviderCard,
	ProviderLogo,
} from "@/components/ai-provider/ProviderCard";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { Section } from "../ui";
import {
	isChanged,
	makeDefault,
	type ProviderDraft,
	setEnabled,
} from "./aiProviderRules";

export interface StaffAiProviders {
	available: AiProvider[];
	allowed: AiProvider[];
	default: AiProvider;
	models?: Partial<Record<AiProvider, string[]>>;
	history: AiHistoryLine[];
	tickets: { id: string; subject: string; created_at: string }[];
}

const key = (orgId: string) => ["v2", "ai-providers", "staff", orgId] as const;

const SHOWN = 3;

export const historyLine = (h: AiHistoryLine, locale: string) => {
	const provider = providerName(h.provider);
	const by = h.by ?? t`Staff`;
	const on = formatDay(h.at, locale);
	const asked = h.request_at ? formatDay(h.request_at, locale) : null;
	const what =
		h.kind === "added"
			? t`${provider} added`
			: h.kind === "removed"
				? t`${provider} removed`
				: t`Default changed to ${provider}`;
	return asked
		? t`${what} by ${by}, ${on}, request of ${asked}`
		: t`${what} by ${by}, ${on}`;
};

/** Staff: the AI providers an account has and its default, changed after a written request. */
export function AiProviderSection({ orgId }: { orgId: string }) {
	const { i18n } = useLingui();
	const { data } = useQuery({
		queryFn: () =>
			aiRequest<StaffAiProviders>(`/v2/admin/orgs/${orgId}/ai-providers`),
		queryKey: key(orgId),
	});
	const [editing, setEditing] = useState(false);
	const [all, setAll] = useState(false);
	if (!data) return null;
	const history = all ? data.history : data.history.slice(0, SHOWN);
	return (
		<Section
			title={<Trans>AI provider</Trans>}
			testId="staff-ai-provider"
			action={
				<Button
					variant="default"
					size="xs"
					onClick={() => setEditing(true)}
					data-testid="ai-provider-edit"
				>
					<Trans>Edit</Trans>
				</Button>
			}
		>
			<Stack gap="sm">
				<Stack gap="xs" data-testid="ai-provider-summary">
					{data.allowed.map((p) => (
						<Group key={p} gap="xs" wrap="nowrap">
							<ProviderLogo provider={p} size={24} />
							<Text size="sm">{providerName(p)}</Text>
							{p === data.default && (
								<Text size="sm" c="dimmed">
									<Trans>Default</Trans>
								</Text>
							)}
						</Group>
					))}
				</Stack>
				{data.history.length > 0 && (
					<Stack gap={4} data-testid="ai-provider-history">
						{history.map((h) => (
							<Text
								size="xs"
								c="dimmed"
								key={`${h.at}-${h.kind}-${h.provider}`}
							>
								{historyLine(h, i18n.locale)}
							</Text>
						))}
						{data.history.length > SHOWN && !all && (
							<UnstyledButton
								onClick={() => setAll(true)}
								data-testid="ai-provider-show-all"
								style={{ alignSelf: "flex-start" }}
							>
								<Text size="xs" td="underline">
									<Trans>Show all</Trans>
								</Text>
							</UnstyledButton>
						)}
					</Stack>
				)}
			</Stack>
			<EditModal
				orgId={orgId}
				data={data}
				opened={editing}
				onClose={() => setEditing(false)}
			/>
		</Section>
	);
}

function EditModal({
	orgId,
	data,
	opened,
	onClose,
}: {
	orgId: string;
	data: StaffAiProviders;
	opened: boolean;
	onClose: () => void;
}) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`AI provider`}
			size="xl"
			centered
		>
			<EditForm orgId={orgId} data={data} onClose={onClose} />
		</Modal>
	);
}

// Mounted with the dialog, so every opening starts from what is saved.
function EditForm({
	orgId,
	data,
	onClose,
}: {
	orgId: string;
	data: StaffAiProviders;
	onClose: () => void;
}) {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const saved: ProviderDraft = { allowed: data.allowed, default: data.default };
	const [draft, setDraft] = useState<ProviderDraft>(saved);
	const [ticket, setTicket] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () =>
			aiRequest<unknown>(`/v2/admin/orgs/${orgId}/ai-providers`, {
				body: JSON.stringify({
					allowed: draft.allowed,
					default: draft.default,
					request_ticket_id: ticket,
				}),
				method: "PUT",
			}),
		onError: (e: Error) => void notifyError(e),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: key(orgId) });
			void queryClient.invalidateQueries({ queryKey: ["accounts"] });
			toast.success(t`AI provider saved`);
			onClose();
		},
	});
	return (
		<Stack gap="lg">
			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
				{data.available.map((p) => {
					const on = draft.allowed.includes(p);
					const isDefault = draft.default === p;
					return (
						<Box key={p} data-testid={`edit-provider-${p}`}>
							<ProviderCard
								provider={p}
								models={data.models?.[p]}
								muted={!on}
								badge={isDefault ? <Trans>Default</Trans> : undefined}
							>
								<Group justify="space-between" mt="auto" wrap="nowrap" mih={32}>
									<Switch
										label={t`Enabled`}
										checked={on}
										disabled={isDefault}
										onChange={(e) =>
											setDraft((d) =>
												setEnabled(
													d,
													p,
													e.currentTarget.checked,
													data.available,
												),
											)
										}
										data-testid={`enabled-${p}`}
									/>
									{!isDefault && (
										<Button
											variant="default"
											size="xs"
											disabled={!on}
											onClick={() => setDraft((d) => makeDefault(d, p))}
											data-testid={`make-default-${p}`}
										>
											<Trans>Make default</Trans>
										</Button>
									)}
								</Group>
							</ProviderCard>
						</Box>
					);
				})}
			</SimpleGrid>
			<Select
				label={t`Request`}
				placeholder={t`Choose the ticket`}
				required
				data={data.tickets.map((x) => ({
					label: `${x.subject} · ${formatDay(x.created_at, i18n.locale)}`,
					value: x.id,
				}))}
				value={ticket}
				onChange={setTicket}
				data-testid="ai-provider-ticket"
			/>
			<Group gap="sm">
				<Button
					disabled={!isChanged(draft, saved) || !ticket}
					loading={save.isPending}
					onClick={() => save.mutate()}
					data-testid="ai-provider-save"
				>
					<Trans>Save</Trans>
				</Button>
				<Button variant="subtle" color="gray" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
			</Group>
		</Stack>
	);
}
