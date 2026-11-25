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
	Title,
	UnstyledButton,
} from "@mantine/core";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	AI_JOBS,
	type AiHistoryLine,
	type AiModels,
	type AiJob,
	type AiProvider,
	aiRequest,
	type CostLines,
	costText,
	euros,
	formatDay,
	jobName,
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
	isLocked,
	makeDefault,
	type ProviderDraft,
	setEnabled,
} from "./aiProviderRules";

export interface StaffAiProviders {
	jobs: AiJob[];
	available: AiProvider[];
	serves: Record<AiProvider, AiJob[]>;
	enabled: Record<AiJob, AiProvider[]>;
	defaults: Record<AiJob, AiProvider>;
	models?: AiModels;
	cost: CostLines;
	month: { from: string; spent: Record<AiProvider, number> };
	history: AiHistoryLine[];
	tickets: { id: string; subject: string; created_at: string }[];
}

const key = (orgId: string) => ["v2", "ai-providers", "staff", orgId] as const;

const SHOWN = 3;

const isProvider = (p: unknown): p is AiProvider =>
	p === "scaleway" || p === "google";

const isJob = (j: unknown): j is AiJob =>
	j === "transcription" || j === "analysis";

/** What one change was, in the short form the history and the timeline share. */
export const changeText = (
	kind: AiHistoryLine["kind"],
	p: AiProvider,
	j: AiJob,
) => {
	const provider = providerName(p);
	const job = jobName(j);
	return kind === "enabled"
		? t`${provider} enabled for ${job}`
		: kind === "disabled"
			? t`${provider} removed from ${job}`
			: t`${provider} is now the default for ${job}`;
};

/** "25 Nov 2026 · Google Vertex AI enabled for Analysis"; Show all adds who made the change. */
export const historyLine = (
	h: AiHistoryLine,
	locale: string,
	withWho = false,
) => {
	const line = `${formatDay(h.at, locale)} · ${changeText(h.kind, h.provider, h.job)}`;
	return withWho && h.by ? `${line} · ${h.by}` : line;
};

/** On hover: who made the change and the request it answers. */
export const historyTitle = (h: AiHistoryLine, locale: string) => {
	const asked = h.request_at ? formatDay(h.request_at, locale) : null;
	return [h.by ?? t`Staff`, asked ? t`Request of ${asked}` : null]
		.filter(Boolean)
		.join(" · ");
};

interface AiSetting {
	enabled?: Partial<Record<AiJob, unknown>>;
	defaults?: Partial<Record<AiJob, unknown>>;
}

const providersOf = (v: unknown): AiProvider[] =>
	Array.isArray(v) ? v.filter(isProvider) : [];

/**
 * What a timeline event of an AI provider change says, one line per change: an account's
 * change from the setting before and after, a project's move with the project's name and job.
 */
export const aiEventLines = (e: {
	type: string;
	detail: unknown;
}): string[] => {
	const d = (e.detail ?? {}) as {
		before?: AiSetting | string | null;
		after?: AiSetting | string | null;
		job?: unknown;
		project_name?: string;
	};
	if (e.type === "project.ai_provider.changed") {
		const name = d.project_name;
		const job = isJob(d.job) ? jobName(d.job) : null;
		const to =
			typeof d.after === "string" && isProvider(d.after) ? d.after : null;
		if (to) {
			const provider = providerName(to);
			if (job)
				return [
					name
						? t`Project ${name} moved to ${provider} for ${job}`
						: t`A project moved to ${provider} for ${job}`,
				];
			return [
				name
					? t`Project ${name} moved to ${provider}`
					: t`A project moved to ${provider}`,
			];
		}
		if (job)
			return [
				name
					? t`Project ${name} back on the account default for ${job}`
					: t`A project back on the account default for ${job}`,
			];
		return [
			name
				? t`Project ${name} back on the account default`
				: t`A project back on the account default`,
		];
	}
	const after = d.after && typeof d.after === "object" ? d.after : null;
	if (!after) return [];
	const before = d.before && typeof d.before === "object" ? d.before : null;
	return AI_JOBS.flatMap((job) => {
		const had = new Set(providersOf(before?.enabled?.[job]));
		const has = new Set(providersOf(after.enabled?.[job]));
		const next = after.defaults?.[job];
		return [
			...[...has]
				.filter((p) => !had.has(p))
				.map((p) => changeText("enabled", p, job)),
			...[...had]
				.filter((p) => !has.has(p))
				.map((p) => changeText("disabled", p, job)),
			...(before && isProvider(next) && before.defaults?.[job] !== next
				? [changeText("default", next, job)]
				: []),
		];
	});
};

/** Staff: the AI providers an account has enabled for each job and its defaults, changed after a written request. */
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
	const google = euros(data.month.spent.google, i18n.locale);
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
					{data.jobs.map((job) => (
						<Group
							key={job}
							gap="md"
							wrap="wrap"
							align="center"
							data-testid={`summary-${job}`}
						>
							<Text size="sm" fw={500} w={110}>
								{jobName(job)}
							</Text>
							<Group gap="md" wrap="wrap">
								{data.enabled[job].map((p) => (
									<Group key={p} gap="xs" wrap="nowrap">
										<ProviderLogo provider={p} size={24} />
										<Text size="sm">{providerName(p)}</Text>
										{p === data.defaults[job] && (
											<Text size="sm" c="dimmed">
												<Trans>Default</Trans>
											</Text>
										)}
									</Group>
								))}
							</Group>
						</Group>
					))}
					<Text size="sm" c="dimmed" data-testid="ai-provider-google-month">
						<Trans>Google this month: {google}</Trans>
					</Text>
				</Stack>
				{data.history.length > 0 && (
					<Stack gap={4} data-testid="ai-provider-history">
						{history.map((h) => (
							<Text
								size="xs"
								c="dimmed"
								key={`${h.at}-${h.kind}-${h.provider}-${h.job}`}
								title={historyTitle(h, i18n.locale)}
							>
								{historyLine(h, i18n.locale, all)}
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
	const saved: ProviderDraft = {
		defaults: data.defaults,
		enabled: data.enabled,
	};
	const [draft, setDraft] = useState<ProviderDraft>(saved);
	const [ticket, setTicket] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () =>
			aiRequest<unknown>(`/v2/admin/orgs/${orgId}/ai-providers`, {
				body: JSON.stringify({
					analysis_default: draft.defaults.analysis,
					analysis_enabled: draft.enabled.analysis,
					request_ticket_id: ticket,
					transcription_default: draft.defaults.transcription,
					transcription_enabled: draft.enabled.transcription,
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
			{data.jobs.map((job) => (
				<Stack key={job} gap="sm" data-testid={`edit-job-${job}`}>
					<Title order={5}>{jobName(job)}</Title>
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
						{data.available
							.filter((p) => data.serves[p].includes(job))
							.map((p) => {
								const on = draft.enabled[job].includes(p);
								const locked = isLocked(draft, job, p);
								return (
									<Box key={p} data-testid={`edit-provider-${job}-${p}`}>
										<ProviderCard
											provider={p}
											models={data.models?.[p]?.[job]}
											muted={!on}
											cost={costText(data.cost[job][p], i18n.locale)}
											badge={
												draft.defaults[job] === p ? (
													<Trans>Default</Trans>
												) : undefined
											}
										>
											<Group mt="auto" wrap="nowrap" mih={32}>
												{/* The default stays on: it reads as on and does not move, never greyed like off. */}
												<Switch
													label={t`Enabled`}
													checked={on}
													readOnly={locked}
													aria-readonly={locked || undefined}
													thumbIcon={
														locked ? (
															<LockSimpleIcon size={10} weight="bold" />
														) : undefined
													}
													styles={
														locked ? { track: { cursor: "default" } } : {}
													}
													onChange={(e) =>
														setDraft((d) =>
															setEnabled(
																d,
																job,
																p,
																e.currentTarget.checked,
																data.available,
																data.serves,
															),
														)
													}
													data-testid={`enabled-${job}-${p}`}
													data-locked={locked ? "" : undefined}
												/>
											</Group>
										</ProviderCard>
									</Box>
								);
							})}
					</SimpleGrid>
					<Select
						label={t`Default`}
						allowDeselect={false}
						data={draft.enabled[job].map((p) => ({
							label: providerName(p),
							value: p,
						}))}
						value={draft.defaults[job]}
						onChange={(v) =>
							v &&
							setDraft((d) =>
								makeDefault(d, job, v === "google" ? "google" : "scaleway"),
							)
						}
						maw={320}
						data-testid={`default-${job}`}
					/>
				</Stack>
			))}
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
