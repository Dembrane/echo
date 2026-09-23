import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Alert,
	Badge,
	Button,
	Drawer,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { I18nLink } from "@/components/common/i18nLink";
import {
	type AnalysisObject,
	type AnalysisRevision,
	useAnalysisLineage,
	useAnalysisObjectHistory,
	useEditAnalysisObject,
	useRollbackAnalysisObject,
	useSetAnalysisMembership,
} from "./hooks";

export type EvidenceInspectionDrawerProps = {
	projectId: string;
	workspaceId?: string;
	snapshotId?: string | null;
	item?: AnalysisObject | null;
	editable?: boolean;
	opened: boolean;
	onClose: () => void;
};

type SourceReference = {
	conversationId?: string;
	quote?: string;
};

function readableFields(value: unknown) {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value as Record<string, unknown>).filter(
		([, field]) =>
			typeof field === "string" ||
			typeof field === "number" ||
			typeof field === "boolean",
	);
}

function conversationPath(
	projectId: string,
	conversationId: string,
	workspaceId?: string,
) {
	const project = workspaceId
		? `/w/${workspaceId}/projects/${projectId}`
		: `/projects/${projectId}`;
	return `${project}/conversations/${conversationId}`;
}

function mutationStatus(error: unknown) {
	return (error as { status?: number } | undefined)?.status;
}

function ResultEditor({
	projectId,
	item,
	history,
	refetchHistory,
}: {
	projectId: string;
	item: AnalysisObject;
	history: AnalysisRevision[];
	refetchHistory: () => Promise<unknown>;
}) {
	const [revisionId, setRevisionId] = useState(item.revisionId);
	const [payload, setPayload] = useState<Record<string, unknown>>(
		item.payload ?? {},
	);
	const [excluded, setExcluded] = useState(Boolean(item.membershipExcluded));
	// Tensions and merged arguments are built from arguments, so withdrawing
	// one reaches them too.
	const feedsOthers = item.type === "argument";
	const [reason, setReason] = useState("");
	const [withdrawOpened, withdrawModal] = useDisclosure(false);
	const [rollbackOpened, rollbackModal] = useDisclosure(false);
	const [rollbackRevision, setRollbackRevision] =
		useState<AnalysisRevision | null>(null);
	const edit = useEditAnalysisObject(projectId, item.objectId);
	const membership = useSetAnalysisMembership(projectId, item.objectId);
	const rollback = useRollbackAnalysisObject(projectId, item.objectId);
	const [refreshingHistory, setRefreshingHistory] = useState(false);
	const pending = edit.isPending || membership.isPending || rollback.isPending;
	const conflict = [edit.error, membership.error, rollback.error].some(
		(error) => mutationStatus(error) === 409,
	);

	useEffect(() => {
		setRevisionId(item.revisionId);
		setPayload(item.payload ?? {});
		setExcluded(Boolean(item.membershipExcluded));
		setReason("");
		setRollbackRevision(null);
		setRefreshingHistory(false);
	}, [item]);

	// A 409 means the cached history is behind, so fetch it again before
	// offering to load "the latest" revision — and keep what the host typed on
	// screen while that runs.
	const onConflict = (error: unknown) => {
		if (mutationStatus(error) !== 409) return;
		setRefreshingHistory(true);
		void refetchHistory().finally(() => setRefreshingHistory(false));
	};

	const accept = (revision: AnalysisRevision) => {
		setRevisionId(revision.revisionId);
		setPayload(revision.payload);
		setExcluded(revision.membershipExcluded);
		setReason("");
	};
	const setField = (key: string, value: unknown) =>
		setPayload((current) => ({ ...current, [key]: value }));
	const save = () =>
		edit.mutate(
			{ expected_revision_id: revisionId, payload, reason: reason || null },
			{ onError: onConflict, onSuccess: ({ revision }) => accept(revision) },
		);
	const decideMembership = (nextExcluded: boolean) => {
		membership.mutate(
			{
				excluded: nextExcluded,
				expected_revision_id: revisionId,
				reason:
					reason ||
					(nextExcluded ? "Withdrawn during review" : "Restored during review"),
			},
			{
				onError: onConflict,
				onSuccess: ({ revision }) => {
					accept(revision);
					withdrawModal.close();
				},
			},
		);
	};
	const restoreRevision = () => {
		if (!rollbackRevision) return;
		rollback.mutate(
			{
				expected_revision_id: revisionId,
				reason:
					reason || `Restored revision ${rollbackRevision.revisionNumber}`,
				to_revision_id: rollbackRevision.revisionId,
			},
			{
				onError: onConflict,
				onSuccess: ({ revision: restored }) => {
					accept(restored);
					rollbackModal.close();
					setRollbackRevision(null);
				},
			},
		);
	};
	const restoreLatest = () => {
		const latest = history.at(-1);
		if (latest) accept(latest);
	};

	return (
		<Stack gap="sm">
			<Title order={4}>
				<Trans>Edit result</Trans>
			</Title>
			{item.type === "argument" && (
				<>
					<Textarea
						label={t`Statement`}
						autosize
						minRows={3}
						value={String(payload.statement ?? "")}
						onChange={(event) =>
							setField("statement", event.currentTarget.value)
						}
					/>
					<Select
						label={t`Kind`}
						value={String(payload.epistemicKind ?? "argument")}
						data={[
							{ label: t`Argument`, value: "argument" },
							{ label: t`Claim`, value: "claim" },
						]}
						onChange={(value) => value && setField("epistemicKind", value)}
					/>
					<Select
						clearable
						label={t`Valence`}
						value={typeof payload.valence === "string" ? payload.valence : null}
						data={[
							{ label: t`Positive`, value: "positive" },
							{ label: t`Negative`, value: "negative" },
							{ label: t`Neutral`, value: "neutral" },
						]}
						onChange={(value) => setField("valence", value)}
					/>
				</>
			)}
			{item.type === "popcorn" && (
				<>
					<TextInput
						label={t`Phrase`}
						maxLength={90}
						value={String(payload.phrase ?? "")}
						onChange={(event) => setField("phrase", event.currentTarget.value)}
					/>
					<Switch
						label={t`This phrase is a question`}
						checked={Boolean(payload.question)}
						onChange={(event) =>
							setField("question", event.currentTarget.checked)
						}
					/>
				</>
			)}
			{item.type === "tension" && (
				<>
					<TextInput
						label={t`First pole`}
						value={String(payload.poleA ?? "")}
						onChange={(event) => setField("poleA", event.currentTarget.value)}
					/>
					<TextInput
						label={t`Second pole`}
						value={String(payload.poleB ?? "")}
						onChange={(event) => setField("poleB", event.currentTarget.value)}
					/>
					<Textarea
						label={t`Tension`}
						autosize
						minRows={2}
						value={String(payload.knot ?? "")}
						onChange={(event) => setField("knot", event.currentTarget.value)}
					/>
					<Textarea
						label={t`Question to resolve`}
						autosize
						minRows={2}
						value={String(payload.toResolve ?? "")}
						onChange={(event) =>
							setField("toResolve", event.currentTarget.value)
						}
					/>
				</>
			)}
			{item.type === "stakeholder" && (
				<>
					<TextInput
						label={t`Name`}
						value={String(payload.name ?? "")}
						onChange={(event) => setField("name", event.currentTarget.value)}
					/>
					<TextInput
						label={t`Role`}
						value={String(payload.role ?? "")}
						onChange={(event) => setField("role", event.currentTarget.value)}
					/>
					<Textarea
						label={t`Stake`}
						autosize
						minRows={2}
						value={String(payload.stake ?? "")}
						onChange={(event) => setField("stake", event.currentTarget.value)}
					/>
					<Select
						label={t`Evidence level`}
						value={String(payload.rung ?? "inferred")}
						data={[
							{ label: t`Voiced directly`, value: "voiced" },
							{ label: t`Named by participants`, value: "named" },
							{ label: t`Inferred`, value: "inferred" },
						]}
						onChange={(value) => value && setField("rung", value)}
					/>
					<TextInput
						label={t`Invoked by`}
						value={String(payload.invokedBy ?? "")}
						onChange={(event) =>
							setField("invokedBy", event.currentTarget.value || null)
						}
					/>
				</>
			)}
			<TextInput
				label={t`Reason for this change`}
				value={reason}
				onChange={(event) => setReason(event.currentTarget.value)}
			/>
			{conflict && (
				<Alert color="red" variant="outline">
					<Stack gap="xs">
						<Text>
							<Trans>This result changed while you were reviewing it.</Trans>
						</Text>
						<Button
							variant="outline"
							w="fit-content"
							loading={refreshingHistory}
							disabled={refreshingHistory}
							onClick={restoreLatest}
						>
							<Trans>Load latest revision</Trans>
						</Button>
					</Stack>
				</Alert>
			)}
			{(edit.isError || membership.isError || rollback.isError) &&
				!conflict && (
					<Alert color="red" variant="outline">
						<Trans>The change could not be published.</Trans>
					</Alert>
				)}
			<Group>
				<Button
					onClick={save}
					loading={edit.isPending}
					disabled={pending || excluded}
				>
					<Trans>Publish revision</Trans>
				</Button>
				<Button
					color={excluded ? "primary" : "red"}
					variant="outline"
					loading={membership.isPending}
					disabled={pending}
					onClick={() =>
						excluded ? decideMembership(false) : withdrawModal.open()
					}
				>
					{excluded ? (
						<Trans>Restore result</Trans>
					) : (
						<Trans>Withdraw result</Trans>
					)}
				</Button>
			</Group>
			{excluded && feedsOthers && (
				<Text size="sm" c="dimmed">
					<Trans>
						Tensions and merged arguments leave this argument out from their
						next update. Restoring it brings it back.
					</Trans>
				</Text>
			)}
			{history.length > 1 && (
				<Accordion variant="contained">
					<Accordion.Item value="rollback">
						<Accordion.Control>
							<Trans>Restore earlier wording</Trans>
						</Accordion.Control>
						<Accordion.Panel>
							<Stack gap="xs">
								{history.slice(0, -1).map((revision) => (
									<Button
										key={revision.revisionId}
										variant="subtle"
										justify="space-between"
										disabled={pending}
										onClick={() => {
											setRollbackRevision(revision);
											rollbackModal.open();
										}}
									>
										<span>
											<Trans>Revision {revision.revisionNumber}</Trans>
										</span>
										<span>
											{String(
												revision.payload.statement ??
													revision.payload.phrase ??
													revision.payload.name ??
													revision.payload.poleA ??
													"",
											)}
										</span>
									</Button>
								))}
							</Stack>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
			)}
			<ConfirmModal
				opened={withdrawOpened}
				onClose={withdrawModal.close}
				onConfirm={() => decideMembership(true)}
				title={t`Withdraw result`}
				message={
					feedsOthers
						? t`Withdraw this argument from current Map and presentation views? Tensions and merged arguments leave it out too, from their next update. Its revision history will remain available.`
						: t`Withdraw this result from current Map and presentation views? Its revision history will remain available.`
				}
				confirmLabel={<Trans>Withdraw result</Trans>}
				confirmColor="red"
				loading={membership.isPending}
				data-testid="analysis-withdraw-modal"
			/>
			<ConfirmModal
				opened={rollbackOpened}
				onClose={() => {
					rollbackModal.close();
					setRollbackRevision(null);
				}}
				onConfirm={restoreRevision}
				title={t`Restore earlier wording`}
				message={t`Restore revision ${rollbackRevision?.revisionNumber ?? ""} as a new revision?`}
				confirmLabel={<Trans>Restore revision</Trans>}
				loading={rollback.isPending}
				data-testid="analysis-rollback-modal"
			/>
		</Stack>
	);
}

export function EvidenceInspectionDrawer({
	projectId,
	workspaceId,
	snapshotId,
	item,
	editable = false,
	opened,
	onClose,
}: EvidenceInspectionDrawerProps) {
	const history = useAnalysisObjectHistory(projectId, item?.objectId);
	const lineage = useAnalysisLineage(snapshotId, item?.revisionId);
	const sources =
		(item?.provenance?.sourceRefs as SourceReference[] | undefined) ?? [];

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="lg"
			title={<Trans>Evidence and history</Trans>}
		>
			{item && (
				<Stack gap="lg">
					{editable &&
						["argument", "popcorn", "tension", "stakeholder"].includes(
							item.type,
						) &&
						item.payload && (
							<ResultEditor
								projectId={projectId}
								item={item}
								history={history.data?.revisions ?? []}
								refetchHistory={() => history.refetch()}
							/>
						)}
					<Stack gap="xs">
						<Group>
							<Badge variant="outline">{item.type}</Badge>
							<Text size="xs">{item.revisionId.slice(0, 8)}</Text>
						</Group>
						<Title order={3}>{item.label ?? item.objectId}</Title>
						{readableFields(item.detail).map(([label, value]) => (
							<Text size="sm" key={label}>
								{label}: {String(value)}
							</Text>
						))}
					</Stack>

					<Stack gap="sm">
						<Title order={4}>
							<Trans>Source evidence</Trans>
						</Title>
						{sources.length === 0 && (
							<Text size="sm">
								<Trans>No source quote was recorded for this result.</Trans>
							</Text>
						)}
						{sources.map((source, index) => (
							<Paper
								withBorder
								p="md"
								key={`${source.conversationId}-${index}`}
							>
								<Stack gap="sm">
									{source.quote && <Text>“{source.quote}”</Text>}
									{source.conversationId && (
										<Button
											component={I18nLink}
											to={conversationPath(
												projectId,
												source.conversationId,
												workspaceId,
											)}
											variant="outline"
											w="fit-content"
										>
											<Trans>Open conversation</Trans>
										</Button>
									)}
								</Stack>
							</Paper>
						))}
					</Stack>

					<Stack gap="sm">
						<Title order={4}>
							<Trans>Revision history</Trans>
						</Title>
						{history.isLoading && <Loader size="sm" />}
						{history.isError && (
							<Alert color="red" variant="outline">
								<Trans>History could not be loaded.</Trans>
							</Alert>
						)}
						{history.data?.revisions.map((revision, index) => {
							const provenance = revision.provenance as
								| Record<string, unknown>
								| undefined;
							return (
								<Paper
									withBorder
									p="md"
									key={revision.revisionId || String(index)}
								>
									<Group justify="space-between">
										<Text fw={600}>
											<Trans>Revision</Trans> {String(revision.revisionNumber)}
										</Text>
										<Badge variant="outline">
											{String(provenance?.origin ?? revision.status)}
										</Badge>
									</Group>
									{typeof revision.reason === "string" && revision.reason && (
										<Text size="sm">{revision.reason}</Text>
									)}
									<Text size="xs">{String(revision.publishedAt ?? "")}</Text>
								</Paper>
							);
						})}
					</Stack>

					<Accordion variant="contained">
						<Accordion.Item value="lineage">
							<Accordion.Control>
								<Trans>Technical lineage</Trans>
							</Accordion.Control>
							<Accordion.Panel>
								{lineage.isLoading && <Loader size="sm" />}
								{lineage.isError && (
									<Alert color="red" variant="outline">
										<Trans>Lineage could not be loaded.</Trans>
									</Alert>
								)}
								{lineage.data && (
									<Text
										component="pre"
										size="xs"
										className="whitespace-pre-wrap break-words"
									>
										{JSON.stringify(lineage.data, null, 2)}
									</Text>
								)}
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>
				</Stack>
			)}
		</Drawer>
	);
}
