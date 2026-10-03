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
	Spoiler,
	Stack,
	Switch,
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
import { presentError } from "@/lib/errors/present";
import { call } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { DemoStatusT } from "../contract/contract.gen";
import { formatDateTime } from "../format";
import { AccountsI18n } from "../i18n";
import { StaffOnly } from "./AccountCardRoute";

type Step = DemoStatusT["steps"][number];

/**
 * Staff: a demo being built, then its draft and the one decision left, Publish. Polls
 * while it is queued or running; a failed step shows why and retries from itself.
 */
export const DemoRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<Demo />
		</StaffOnly>
	</AccountsI18n>
);

const stepLabel = (name: Step["name"]): string =>
	({
		author: t`Corpus`,
		extract: t`Extraction`,
		fetch: t`Website`,
		research: t`Research`,
		review: t`Draft ready`,
		seed: t`Seeding`,
	})[name];

export const demoKey = (id: string) => ["accounts", "demo", id] as const;

function Demo() {
	const { demoId } = useParams<{ demoId: string }>();
	const queryClient = useQueryClient();
	const { i18n } = useLingui();
	const [busy, setBusy] = useState<"retry" | "publish" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { data: demo, isLoading } = useQuery({
		enabled: Boolean(demoId),
		queryFn: () => call("demoStatus", { params: { demoId: demoId as string } }),
		queryKey: demoKey(demoId ?? ""),
		refetchInterval: (q) =>
			q.state.data?.status === "running" || q.state.data?.status === "queued"
				? 1500
				: false,
	});
	useDocumentTitle(
		demo ? `${demo.organisation_name} | ${t`Demo`}` : t`Demo | dembrane`,
	);

	const act = async (what: "retry" | "publish", signIn?: boolean) => {
		if (!demoId) return;
		setBusy(what);
		setError(null);
		try {
			const next =
				what === "retry"
					? await call("retryDemo", { params: { demoId } })
					: await call("publishDemo", {
							body: { sign_in: signIn },
							params: { demoId },
						});
			queryClient.setQueryData(demoKey(demoId), next);
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
		} catch (e) {
			setError((await presentError(e, i18n)).message);
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
					<Title order={3}>{demo.organisation_name}</Title>
					<Text size="sm" c="dimmed">
						{demo.status === "published" ? (
							<Trans>
								Published {formatDateTime(demo.published_at, i18n.locale)}.
							</Trans>
						) : demo.status === "draft" ? (
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
							<StepRow
								key={step.name}
								step={step}
								busy={busy === "retry"}
								onRetry={() => act("retry")}
							/>
						))}
					</Stack>
				</Paper>

				{(demo.status === "draft" || demo.status === "published") && (
					<Draft
						demo={demo}
						busy={busy === "publish"}
						onPublish={(signIn) => act("publish", signIn)}
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

function StepRow({
	step,
	busy,
	onRetry,
}: {
	step: Step;
	busy: boolean;
	onRetry: () => void;
}) {
	return (
		<Stack
			gap={4}
			data-testid={`demo-step-${step.name}`}
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
					{stepLabel(step.name)}
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
	demo: DemoStatusT;
	busy: boolean;
	onPublish: (signIn: boolean) => void;
}) {
	const [signIn, setSignIn] = useState(demo.sign_in);
	const published = demo.status === "published";
	return (
		<Stack gap="md" data-testid="demo-draft">
			<Stack gap={6}>
				{demo.links.public.map((l) => (
					<Group key={l.url} gap="xs">
						<Anchor
							href={l.url}
							target="_blank"
							rel="noreferrer"
							size="sm"
							data-testid="demo-public-link"
						>
							<Trans>Public demo ({l.language.toUpperCase()})</Trans>
						</Anchor>
						<Text size="xs" c="dimmed">
							{l.live ? (
								<Trans>live</Trans>
							) : (
								<Trans>not live until you publish</Trans>
							)}
						</Text>
					</Group>
				))}
				{demo.links.projects.map((p) => (
					<Anchor
						key={p.project_id}
						href={p.url}
						target="_blank"
						rel="noreferrer"
						size="sm"
						data-testid="demo-project-link"
					>
						<Trans>Project in the dashboard ({p.language.toUpperCase()})</Trans>
					</Anchor>
				))}
				{demo.org_id && (
					<Anchor
						component={I18nLink}
						to={`/admin/accounts/${demo.org_id}`}
						size="sm"
					>
						<Trans>The account</Trans>
					</Anchor>
				)}
				{demo.conversations != null && (
					<Text size="xs" c="dimmed">
						<Trans>
							{demo.conversations} fictional conversations authored.
						</Trans>
					</Text>
				)}
			</Stack>
			{demo.research && (
				<Paper withBorder radius="md" p="sm">
					<Text size="sm" mb={4}>
						<Trans>Research</Trans>
					</Text>
					<Spoiler
						maxHeight={90}
						showLabel={t`Show all`}
						hideLabel={t`Show less`}
					>
						<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
							{demo.research}
						</Text>
					</Spoiler>
				</Paper>
			)}
			{published ? (
				<Alert color="green" variant="light" data-testid="demo-published">
					{demo.invited_at ? (
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
				<Stack gap="sm">
					<Switch
						checked={signIn}
						onChange={(e) => setSignIn(e.currentTarget.checked)}
						label={t`Send the sign-in invitation`}
						description={
							signIn
								? t`Publishing emails ${demo.contact_email} a sign-in code.`
								: t`Publishing makes the demo live. No email goes out.`
						}
						data-testid="demo-publish-sign-in"
					/>
					<Group>
						<Button
							size="md"
							onClick={() => onPublish(signIn)}
							loading={busy}
							data-testid="demo-publish"
						>
							<Trans>Publish</Trans>
						</Button>
					</Group>
				</Stack>
			)}
		</Stack>
	);
}
