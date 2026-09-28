import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Button,
	Container,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import {
	ArrowLeftIcon,
	CheckIcon,
	CircleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { call } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { DemoStepT, DemoT } from "../api/provisional";
import { formatDateTime } from "../format";
import { AccountsI18n } from "../i18n";
import { StaffOnly } from "./AccountCardRoute";

/**
 * Staff: a demo being built, then its draft and the one decision left, Publish. Polls
 * while a step runs; a failed step shows why and retries on its own.
 */
export const DemoRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<Demo />
		</StaffOnly>
	</AccountsI18n>
);

const stepLabel = (key: DemoStepT["key"]): string =>
	({
		corpus: t`Corpus`,
		draft: t`Draft ready`,
		extraction: t`Extraction`,
		research: t`Research`,
		seeding: t`Seeding`,
		website: t`Website`,
	})[key];

const demoKey = (id: string) => ["accounts", "demo", id] as const;

function Demo() {
	const { demoId } = useParams<{ demoId: string }>();
	const queryClient = useQueryClient();
	const { i18n } = useLingui();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { data: demo, isLoading } = useQuery({
		enabled: Boolean(demoId),
		queryFn: () => call("readDemo", { params: { demoId: demoId as string } }),
		queryKey: demoKey(demoId ?? ""),
		refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
	});
	useDocumentTitle(
		demo ? `${demo.organisation_name} | ${t`Demo`}` : t`Demo | dembrane`,
	);

	const act = async (what: "retry" | "publish", step?: DemoStepT["key"]) => {
		if (!demoId) return;
		setBusy(what);
		setError(null);
		try {
			const next =
				what === "retry"
					? await call("retryDemo", {
							body: { step: step as DemoStepT["key"] },
							params: { demoId },
						})
					: await call("publishDemo", { params: { demoId } });
			queryClient.setQueryData(demoKey(demoId), next);
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	if (isLoading || !demo) return <Loader m="xl" size="sm" />;

	return (
		<Container size="sm" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap="lg" data-testid="demo-screen" data-status={demo.status}>
				<Stack gap={4}>
					<Anchor
						component={I18nLink}
						to="/admin/accounts"
						size="sm"
						c="dimmed"
					>
						<Group gap={4}>
							<ArrowLeftIcon size={14} />
							<Trans>Accounts</Trans>
						</Group>
					</Anchor>
					<Title order={3} fw={400}>
						{demo.organisation_name}
					</Title>
					<Text size="sm" c="dimmed">
						{demo.status === "published" ? (
							<Trans>
								Published {formatDateTime(demo.published_at, i18n.locale)}.
							</Trans>
						) : demo.status === "draft_ready" ? (
							<Trans>The draft is ready. Check it, then publish.</Trans>
						) : demo.status === "failed" ? (
							<Trans>A step failed. Retry it once the cause is fixed.</Trans>
						) : (
							<Trans>Building the demo. This page follows along.</Trans>
						)}
					</Text>
				</Stack>

				<Paper withBorder radius="md" p="sm">
					<Stack gap={10}>
						{demo.steps.map((step) => (
							<Step
								key={step.key}
								step={step}
								busy={busy === "retry"}
								onRetry={() => act("retry", step.key)}
							/>
						))}
					</Stack>
				</Paper>

				{(demo.status === "draft_ready" || demo.status === "published") && (
					<Draft
						demo={demo}
						busy={busy === "publish"}
						onPublish={() => act("publish")}
					/>
				)}
				{error && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}
			</Stack>
		</Container>
	);
}

function Step({
	step,
	busy,
	onRetry,
}: {
	step: DemoStepT;
	busy: boolean;
	onRetry: () => void;
}) {
	return (
		<Stack
			gap={4}
			data-testid={`demo-step-${step.key}`}
			data-status={step.status}
		>
			<Group gap="sm" wrap="nowrap">
				{step.status === "done" ? (
					<ThemeIcon size={22} radius="xl" color="green" variant="light">
						<CheckIcon size={13} />
					</ThemeIcon>
				) : step.status === "running" ? (
					<ThemeIcon size={22} radius="xl" color="blue" variant="light">
						<Loader size={12} />
					</ThemeIcon>
				) : step.status === "failed" ? (
					<ThemeIcon size={22} radius="xl" color="red" variant="light">
						<WarningIcon size={13} />
					</ThemeIcon>
				) : (
					<ThemeIcon size={22} radius="xl" color="gray" variant="light">
						<CircleIcon size={10} />
					</ThemeIcon>
				)}
				<Text
					size="sm"
					c={step.status === "pending" ? "dimmed" : undefined}
					style={{ flex: 1 }}
				>
					{stepLabel(step.key)}
				</Text>
				{step.status === "failed" && (
					<Button
						size="compact-xs"
						variant="light"
						color="red"
						loading={busy}
						onClick={onRetry}
						data-testid="demo-retry"
					>
						<Trans>Retry</Trans>
					</Button>
				)}
			</Group>
			{step.status === "failed" && step.error && (
				<Text size="xs" c="red.8" pl={34}>
					{step.error}
				</Text>
			)}
		</Stack>
	);
}

function Draft({
	demo,
	busy,
	onPublish,
}: {
	demo: DemoT;
	busy: boolean;
	onPublish: () => void;
}) {
	const published = demo.status === "published";
	return (
		<Stack gap="sm" data-testid="demo-draft">
			<Group gap="lg">
				{demo.public_url && (
					<Anchor
						href={demo.public_url}
						target="_blank"
						rel="noreferrer"
						size="sm"
						data-testid="demo-public-link"
					>
						<Trans>Open the public demo</Trans>
					</Anchor>
				)}
				{demo.project_url && (
					<Anchor
						component={I18nLink}
						to={demo.project_url}
						size="sm"
						data-testid="demo-project-link"
					>
						<Trans>Open the project</Trans>
					</Anchor>
				)}
				<Anchor
					component={I18nLink}
					to={`/admin/accounts/${demo.org_id}`}
					size="sm"
				>
					<Trans>Open the account</Trans>
				</Anchor>
			</Group>
			{published ? (
				<Alert color="green" variant="light" data-testid="demo-published">
					{demo.invitation_sent_at ? (
						<Trans>
							Published. {demo.contact_email} has the sign-in invitation.
						</Trans>
					) : (
						<Trans>
							Published. No email went out; share the demo link yourself.
						</Trans>
					)}
				</Alert>
			) : (
				<Group gap="sm" align="center">
					<Button
						size="md"
						onClick={onPublish}
						loading={busy}
						data-testid="demo-publish"
					>
						<Trans>Publish</Trans>
					</Button>
					<Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
						{demo.email_code_sign_in ? (
							<Trans>
								Publishing sends {demo.contact_email} a sign-in invitation with
								an email code.
							</Trans>
						) : (
							<Trans>Publishing makes the demo live. No email goes out.</Trans>
						)}
					</Text>
				</Group>
			)}
		</Stack>
	);
}
