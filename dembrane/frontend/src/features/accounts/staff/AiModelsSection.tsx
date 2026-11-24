import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	Group,
	Paper,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	type AiHistoryLine,
	type AiProvider,
	aiRequest,
	formatDay,
	providerLabel,
	providerName,
} from "@/components/ai-models/hooks";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { Section } from "../ui";

interface StaffAiProviders {
	available: AiProvider[];
	allowed: AiProvider[];
	default: AiProvider;
	history: AiHistoryLine[];
	tickets: { id: string; subject: string; created_at: string }[];
}

const key = (orgId: string) => ["v2", "ai-providers", "staff", orgId] as const;

const line = (h: AiHistoryLine, locale: string) => {
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

/** Staff: the AI providers this account may use and its default, changed after a written request. */
export function AiModelsSection({ orgId }: { orgId: string }) {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryFn: () =>
			aiRequest<StaffAiProviders>(`/v2/admin/orgs/${orgId}/ai-providers`),
		queryKey: key(orgId),
	});
	const [allowed, setAllowed] = useState<AiProvider[]>([]);
	const [def, setDef] = useState<AiProvider>("scaleway");
	const [ticket, setTicket] = useState<string | null>(null);
	useEffect(() => {
		if (!data) return;
		setAllowed(data.allowed);
		setDef(data.default);
	}, [data]);
	const save = useMutation({
		mutationFn: () =>
			aiRequest<unknown>(`/v2/admin/orgs/${orgId}/ai-providers`, {
				body: JSON.stringify({
					allowed,
					default: def,
					request_ticket_id: ticket,
				}),
				method: "PUT",
			}),
		onError: (e: Error) => void notifyError(e),
		onSuccess: () => {
			setTicket(null);
			void queryClient.invalidateQueries({ queryKey: key(orgId) });
			void queryClient.invalidateQueries({ queryKey: ["accounts"] });
			toast.success(t`AI models saved`);
		},
	});
	if (!data) return null;
	const changed =
		allowed.length !== data.allowed.length ||
		allowed.some((p) => !data.allowed.includes(p)) ||
		def !== data.default;
	const toggle = (p: AiProvider, on: boolean) => {
		const next = on ? [...allowed, p] : allowed.filter((x) => x !== p);
		setAllowed(next);
		if (!next.includes(def) && next[0]) setDef(next[0]);
	};
	return (
		<Section title={<Trans>AI models</Trans>} testId="staff-ai-models">
			<Paper withBorder radius="md" p="sm">
				<Stack gap="sm">
					<Stack gap={4}>
						{data.available.map((p) => (
							<Checkbox
								key={p}
								label={providerLabel(p)}
								checked={allowed.includes(p)}
								disabled={allowed.length === 1 && allowed.includes(p)}
								onChange={(e) => toggle(p, e.currentTarget.checked)}
							/>
						))}
					</Stack>
					<Select
						label={t`Default`}
						allowDeselect={false}
						data={allowed.map((p) => ({ label: providerLabel(p), value: p }))}
						value={def}
						onChange={(v) => v && setDef(v as AiProvider)}
					/>
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
					/>
					<Group>
						<Button
							disabled={!changed || !ticket}
							loading={save.isPending}
							onClick={() => save.mutate()}
							data-testid="ai-models-save"
						>
							<Trans>Save</Trans>
						</Button>
					</Group>
					{data.history.length > 0 && (
						<Stack gap={2}>
							{data.history.map((h) => (
								<Text
									size="xs"
									c="dimmed"
									key={`${h.at}-${h.kind}-${h.provider}`}
								>
									{line(h, i18n.locale)}
								</Text>
							))}
						</Stack>
					)}
				</Stack>
			</Paper>
		</Section>
	);
}
