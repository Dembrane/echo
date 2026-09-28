import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	CopyButton,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { AgentGrantsCard } from "./AgentGrantsCard";
import { useAgentGrantsQuery, useAgentServersQuery } from "./hooks";
import { YourOrganisations } from "./YourOrganisations";

const McpUrlField = ({ url }: { url: string }) => (
	<Stack gap="xs">
		<TextInput
			value={url}
			readOnly
			label={t`MCP URL`}
			onFocus={(e) => e.currentTarget.select()}
			rightSection={
				<CopyButton value={url} timeout={2000}>
					{({ copied, copy }) => (
						<Tooltip label={copied ? t`Copied` : t`Copy URL`} withArrow>
							<ActionIcon
								variant="subtle"
								color={copied ? "teal" : "gray"}
								onClick={copy}
								aria-label={copied ? t`URL copied` : t`Copy URL`}
							>
								{copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
			}
			data-testid="agent-mcp-url"
		/>
	</Stack>
);

export const SectionHeading = ({ children }: { children: React.ReactNode }) => (
	<Title order={5}>{children}</Title>
);

// Shown once per user, before the URL is useful to them. Closing it without
// accepting leaves the page: the URL stays out of reach until they read it.
// Acceptance is recorded once; what the organisations do later changes nothing.
const acceptNotice = async () => {
	const response = await fetch(`${API_BASE_URL}/v2/me`, {
		body: JSON.stringify({
			settings: { agent_notice_accepted_at: new Date().toISOString() },
		}),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "PATCH",
	});
	if (!response.ok) throw new Error(t`Failed to update settings`);
};

export const AgentNoticeModal = () => {
	const { data: me } = useV2Me();
	const queryClient = useQueryClient();
	const navigate = useI18nNavigate();

	const accept = useMutation({
		mutationFn: acceptNotice,
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
		},
	});

	const goBack = () => navigate("/o");

	if (!me || me.settings?.agent_notice_accepted_at) return null;

	return (
		<Modal
			opened
			onClose={goBack}
			closeButtonProps={{ "aria-label": t`Close` }}
			title={t`Your data will leave dembrane`}
			data-testid="agent-notice-modal"
		>
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						An AI assistant you connect, and the company that runs it, will
						receive the conversations and projects you allow. dembrane is not
						responsible for what they do with that data. You can revoke a
						connection at any time.
					</Trans>
				</Text>
				<Group justify="flex-end">
					<Button
						variant="subtle"
						onClick={goBack}
						disabled={accept.isPending}
						data-testid="agent-notice-back"
					>
						<Trans>Go back</Trans>
					</Button>
					<Button
						onClick={() => accept.mutate()}
						loading={accept.isPending}
						data-testid="agent-notice-accept"
					>
						<Trans>I understand</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};

// Help > Connect your agent. Beta surface in four plain sections: what
// this is, where it works, how to connect, what is connected. The risk text
// lives in the first-visit modal only; repeating it here made the page shout.
export const AgentAccessSection = () => {
	const { data: servers, isLoading: serversLoading } = useAgentServersQuery();
	const { data: grants, isLoading: grantsLoading } = useAgentGrantsQuery();

	return (
		<Stack gap="xl">
			<AgentNoticeModal />
			<Stack gap="sm">
				<Stack gap={4}>
					<Group gap="sm" align="center">
						<Title order={3}>
							<Trans>Connect your agent</Trans>
						</Title>
						<Badge variant="light" size="sm">
							<Trans>Beta</Trans>
						</Badge>
					</Group>
				</Stack>
				<Text size="sm">
					<Trans>
						MCP is a bridge that lets an AI assistant such as Claude, ChatGPT or
						Le Chat read your dembrane conversations and projects. It can see
						everything you can see, in the organisations you allow.
					</Trans>
				</Text>
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>Your organisations</Trans>
				</SectionHeading>
				<YourOrganisations />
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>Connect</Trans>
				</SectionHeading>
				{serversLoading ? (
					<Group justify="center" py="md">
						<Loader size="sm" color="gray" />
					</Group>
				) : (
					(servers?.servers ?? []).map((server) => (
						<McpUrlField key={server.id} url={server.mcp_url} />
					))
				)}
				<Text size="sm" c="dimmed">
					<Trans>
						Your agent will open dembrane and ask your permission before it can
						read anything.
					</Trans>
				</Text>
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>Connected agents</Trans>
				</SectionHeading>
				<AgentGrantsCard grants={grants} isLoading={grantsLoading} bare />
			</Stack>
		</Stack>
	);
};
