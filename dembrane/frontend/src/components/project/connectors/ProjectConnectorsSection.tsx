import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Modal,
	Paper,
	Select,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	PencilSimpleIcon,
	PlusIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { openConfirm } from "@/lib/openConfirm";
import { ProjectSettingsSection } from "../ProjectSettingsSection";
import {
	type ConnectorSource,
	type ConnectorVoice,
	type MiroBoard,
	useConnectMiro,
	useConnectorProviders,
	useConnectorSources,
	useDisconnectMiro,
	useMiroBoards,
	useMiroFrames,
	useRemoveSource,
	useSaveSource,
	useSyncSource,
} from "./api";

const voiceLabel = (voice: ConnectorVoice) =>
	({
		mixed: t`Mixed`,
		organisers: t`Organising team`,
		participants: t`Participants`,
	})[voice];

const errorLabel = (error: ConnectorSource["error"]) => {
	if (error === "not_connected")
		return t`Miro is no longer connected. Connect it again to keep this board in sync.`;
	if (error === "board_not_found")
		return t`The board was deleted or your Miro account lost access to it.`;
	return t`Miro did not answer. We will try again.`;
};

/**
 * Connected apps on the project's integrations page. Each Miro frame picked here becomes
 * one input of the project, marked with whose words it holds, and stays in sync with the
 * board. Shown only when the server has the Miro app configured.
 */
export const ProjectConnectorsSection = ({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) => {
	const providers = useConnectorProviders();
	const miro = providers.data?.find((p) => p.provider === "miro");
	const sources = useConnectorSources(projectId, !!miro?.configured);
	const connect = useConnectMiro(projectId);
	const disconnect = useDisconnectMiro();
	const [editing, setEditing] = useState<ConnectorSource | null>(null);
	const [opened, { open, close }] = useDisclosure(false);
	const [params, setParams] = useSearchParams();

	// Back from Miro's sign-in page: say how it went, then drop the parameters.
	useEffect(() => {
		const status = params.get("status");
		if (params.get("connector") !== "miro" || !status) return;
		if (status === "connected") toast.success(t`Miro is connected.`);
		else if (status === "denied") toast.error(t`Miro was not connected.`);
		else toast.error(t`Connecting Miro did not work. Try again.`);
		const next = new URLSearchParams(params);
		next.delete("connector");
		next.delete("status");
		setParams(next, { replace: true });
	}, [params, setParams]);

	if (!miro?.configured) return null;
	const account = miro.account_name;

	return (
		<ProjectSettingsSection
			title={<Trans>Connected apps</Trans>}
			description={
				<Trans>
					Bring material from other apps into this project. Each Miro frame you
					pick becomes an input that chats, reports and analysis read, marked
					with whose words it holds.
				</Trans>
			}
			headerRight={
				canEdit &&
				miro.connected && (
					<Button
						leftSection={<PlusIcon />}
						onClick={() => {
							setEditing(null);
							open();
						}}
					>
						<Trans>Add a Miro board</Trans>
					</Button>
				)
			}
		>
			{canEdit && !miro.connected && (
				<Group>
					<Button loading={connect.isPending} onClick={() => connect.mutate()}>
						<Trans>Connect Miro</Trans>
					</Button>
					<Text size="sm" c="dimmed">
						<Trans>dembrane only reads boards. It never changes them.</Trans>
					</Text>
				</Group>
			)}
			{miro.connected && (
				<Text size="sm" c="dimmed">
					{account
						? t`Connected to Miro as ${account}.`
						: t`Connected to Miro.`}{" "}
					{canEdit && (
						<Anchor
							component="button"
							size="sm"
							onClick={() => disconnect.mutate()}
						>
							<Trans>Disconnect</Trans>
						</Anchor>
					)}
				</Text>
			)}

			{sources.data?.map((s) => (
				<SourceRow
					key={s.id}
					projectId={projectId}
					source={s}
					canEdit={canEdit}
					onEdit={() => {
						setEditing(s);
						open();
					}}
				/>
			))}

			{opened && (
				<SourceModal projectId={projectId} source={editing} onClose={close} />
			)}
		</ProjectSettingsSection>
	);
};

const SourceRow = ({
	projectId,
	source,
	canEdit,
	onEdit,
}: {
	projectId: string;
	source: ConnectorSource;
	canEdit: boolean;
	onEdit: () => void;
}) => {
	const sync = useSyncSource(projectId);
	const remove = useRemoveSource(projectId);
	const busy = source.status === "pending" || source.status === "syncing";
	const frames = source.frame_ids.length;
	const inputs = source.inputs;
	const ago = source.last_synced_at
		? formatDistanceToNow(new Date(source.last_synced_at), { addSuffix: true })
		: null;
	return (
		<Paper withBorder p="md">
			<Stack gap="xs">
				<Group justify="space-between" wrap="nowrap">
					<Group gap="xs" wrap="nowrap">
						<Text fw={500}>{source.name ?? t`Miro board`}</Text>
						{source.url && (
							<Anchor
								href={source.url}
								target="_blank"
								aria-label={t`Open in Miro`}
							>
								<ArrowSquareOutIcon />
							</Anchor>
						)}
						<Badge variant="light">{voiceLabel(source.voice)}</Badge>
					</Group>
					{canEdit && (
						<Group gap="xs" wrap="nowrap">
							<Button
								size="xs"
								variant="subtle"
								leftSection={<ArrowClockwiseIcon />}
								loading={busy || sync.isPending}
								onClick={() => sync.mutate(source.id)}
							>
								<Trans>Sync now</Trans>
							</Button>
							<Button
								size="xs"
								variant="subtle"
								leftSection={<PencilSimpleIcon />}
								onClick={onEdit}
							>
								<Trans>Frames</Trans>
							</Button>
							<Button
								size="xs"
								variant="subtle"
								color="red"
								leftSection={<TrashIcon />}
								loading={remove.isPending}
								onClick={() =>
									openConfirm({
										children: t`Its ${inputs} inputs are deleted from the project. The board on Miro stays as it is.`,
										danger: true,
										labels: { confirm: t`Remove` },
										onConfirm: () => remove.mutate(source.id),
										title: t`Remove this board?`,
									})
								}
							>
								<Trans>Remove</Trans>
							</Button>
						</Group>
					)}
				</Group>
				<Text size="sm" c="dimmed">
					{busy
						? t`Reading the board…`
						: ago
							? t`${frames} frames picked, ${inputs} inputs, synced ${ago}.`
							: t`${frames} frames picked.`}
				</Text>
				{source.status === "error" && (
					<Alert color="orange" variant="light">
						{errorLabel(source.error)}
					</Alert>
				)}
			</Stack>
		</Paper>
	);
};

/** Pick a board (search or paste a link), then its frames and whose words they hold. */
const SourceModal = ({
	projectId,
	source,
	onClose,
}: {
	projectId: string;
	source: ConnectorSource | null;
	onClose: () => void;
}) => {
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 300);
	const [board, setBoard] = useState<MiroBoard | null>(
		source
			? { id: source.external_id, name: source.name ?? "", url: source.url }
			: null,
	);
	const boards = useMiroBoards(projectId, debounced, !board);
	const frames = useMiroFrames(projectId, board?.id ?? null);
	const [picked, setPicked] = useState<string[]>(source?.frame_ids ?? []);
	const [voice, setVoice] = useState<ConnectorVoice>(
		source?.voice ?? "organisers",
	);
	const save = useSaveSource(projectId);
	const boardName = source?.name ?? "";

	return (
		<Modal
			opened
			onClose={onClose}
			size="lg"
			title={source ? t`Frames from ${boardName}` : t`Add a Miro board`}
		>
			<Stack>
				{!board && (
					<>
						<TextInput
							autoFocus
							label={t`Board`}
							placeholder={t`Search your boards or paste a board link`}
							value={query}
							onChange={(e) => setQuery(e.currentTarget.value)}
						/>
						{boards.isLoading && <Loader size="sm" />}
						{boards.data?.map((b) => (
							<UnstyledButton key={b.id} onClick={() => setBoard(b)}>
								<Paper withBorder p="sm">
									<Text>{b.name}</Text>
								</Paper>
							</UnstyledButton>
						))}
						{boards.data?.length === 0 && (
							<Text size="sm" c="dimmed">
								<Trans>No boards found.</Trans>
							</Text>
						)}
					</>
				)}

				{board && (
					<>
						<Text fw={500}>{board.name}</Text>
						{frames.isLoading && <Loader size="sm" />}
						{frames.data?.length === 0 && (
							<Text size="sm" c="dimmed">
								<Trans>
									This board has no frames. Group the content you want in frames
									on Miro first.
								</Trans>
							</Text>
						)}
						{!!frames.data?.length && (
							<Checkbox.Group
								label={t`Frames to bring in`}
								description={t`Each frame becomes one input.`}
								value={picked}
								onChange={setPicked}
							>
								<Stack gap="xs" mt="xs">
									{frames.data.map((f) => (
										<Checkbox
											key={f.id}
											value={f.id}
											label={f.title || t`Untitled frame`}
										/>
									))}
								</Stack>
							</Checkbox.Group>
						)}
						<Select
							label={t`Whose words are these?`}
							description={t`Readers can keep the organising team's material apart from what participants said.`}
							value={voice}
							onChange={(v) => v && setVoice(v as ConnectorVoice)}
							allowDeselect={false}
							data={(["organisers", "participants", "mixed"] as const).map(
								(v) => ({ label: voiceLabel(v), value: v }),
							)}
						/>
						<Group justify="space-between">
							{!source ? (
								<Button variant="subtle" onClick={() => setBoard(null)}>
									<Trans>Pick another board</Trans>
								</Button>
							) : (
								<span />
							)}
							<Button
								disabled={!picked.length}
								loading={save.isPending}
								onClick={() =>
									save.mutate(
										source
											? { frame_ids: picked, id: source.id, voice }
											: { board: board.id, frame_ids: picked, voice },
										{ onSuccess: onClose },
									)
								}
							>
								<Trans>Save and sync</Trans>
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
};
