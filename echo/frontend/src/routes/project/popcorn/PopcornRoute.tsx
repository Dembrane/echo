import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Checkbox,
	CopyButton,
	Group,
	Modal,
	Paper,
	Popover,
	SegmentedControl,
	Select,
	Skeleton,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle, useFullscreen } from "@mantine/hooks";
import {
	ArrowSquareOutIcon,
	CheckIcon,
	CopyIcon,
	PencilSimpleIcon,
	PresentationIcon,
	ShareNetworkIcon,
} from "@phosphor-icons/react";
import { addDays, addHours, format, formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type PopcornDetail,
	type PopcornVersion,
	type PopcornVoice,
	type PopcornVoicePreset,
	popcornEmbedSnippet,
	popcornHostViewUrl,
	popcornPublicUrl,
	popcornSampleViewUrl,
	useCreatePopcornMutation,
	useInvalidatePopcorn,
	usePopcornLifecycleMutation,
	usePopcornLoopSettingsMutation,
	usePopcornSettingsMutation,
	usePopcornVersions,
	useProjectPopcorn,
	useRefreshPopcornMutation,
} from "@/components/popcorn/hooks";
import { PricingTextInput } from "@/components/pricing/PricingTextInput";
import {
	useProjectById,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import { API_BASE_URL, ENABLE_CANVAS } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import { type Tier, TIER_ORDER } from "@/lib/tiers";

type Duration = "8h" | "24h" | "3d";
// One control size for every field on these forms, including the voice
// composer, so nothing looks like it belongs to another screen.
const FIELD_SIZE = "sm";

function expiryFor(duration: Duration): Date {
	const now = new Date();
	if (duration === "8h") return addHours(now, 8);
	if (duration === "24h") return addHours(now, 24);
	return addDays(now, 3);
}

function relativeTime(value?: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return formatDistanceToNow(date, { addSuffix: true });
}

function meetsTier(tier: string | null | undefined, minimum: Tier): boolean {
	const index = TIER_ORDER.indexOf((tier ?? "free") as Tier);
	return index >= 0 && index >= TIER_ORDER.indexOf(minimum);
}

function statusLine(popcorn: PopcornDetail): string {
	const loop = popcorn.loop;
	const counts = popcorn.counts;
	const read = t`${counts.conversations} conversations · ${counts.phrases} phrases`;
	if (!loop) return read;
	if (loop.status === "paused")
		return t`Not reading new conversations · ${read}`;
	if (["expired", "ended", "stopped"].includes(loop.status)) {
		return t`Ended · ${read}`;
	}
	const every = loop.cadence_minutes ?? 2;
	const last = relativeTime(loop.last_run_started_at);
	const expiry = loop.expires_at ? new Date(loop.expires_at) : null;
	const until =
		expiry && !Number.isNaN(expiry.getTime())
			? t`Live until ${format(expiry, "EEE d MMM, HH:mm")}`
			: t`Live`;
	const rhythm = last
		? t`Reads new conversations every ${every} minutes, last read ${last}`
		: t`Reading the conversations now`;
	return `${until} · ${rhythm} · ${read}`;
}

// Same shape as the booking form's use-case step: a few checkable ways to
// steer the phrases, each with one line of explanation, and "something else"
// revealing the typed-or-spoken free text. Nothing chosen means Jorim's prompt
// exactly as written.
function VoiceFields({
	projectId,
	voice,
	onChange,
}: {
	projectId: string;
	voice: PopcornVoice;
	onChange: (voice: PopcornVoice) => void;
}) {
	const [otherOpen, setOtherOpen] = useState(!!voice.note);
	// The default is the prompt as written. It is on whenever nothing else is,
	// and choosing it clears everything else, so it reads as one of the choices
	// rather than as the absence of one.
	const isDefault = voice.presets.length === 0 && !voice.note && !otherOpen;
	const options: Array<{
		key: PopcornVoicePreset;
		label: string;
		description: string;
	}> = [
		{
			description: t`The softer of two ways the room said a thing. Nothing that names or blames a person.`,
			key: "gentle",
			label: t`Gentle on people`,
		},
		{
			description: t`The plainest wording the room used. No metaphors or jokes the room did not come back to.`,
			key: "plain",
			label: t`Keep it plain`,
		},
		{
			description: t`Favour what became a decision, a need or a next step.`,
			key: "decisions",
			label: t`Lean towards decisions`,
		},
	];
	return (
		<Stack gap="sm">
			<Text fw={500}>
				<Trans>How should the phrases sound?</Trans>
			</Text>
			<Checkbox
				checked={isDefault}
				onChange={(event) => {
					if (!event.currentTarget.checked) return;
					setOtherOpen(false);
					onChange({ note: "", presets: [] });
				}}
				label={t`dembrane default`}
				description={t`The room's own words, the ideas that moved the conversation. Nothing added, nothing softened.`}
				size={FIELD_SIZE}
				{...testId("popcorn-voice-default")}
			/>
			<Checkbox.Group
				value={voice.presets}
				onChange={(next) =>
					onChange({ ...voice, presets: next as PopcornVoicePreset[] })
				}
			>
				<Stack gap="sm">
					{options.map((option) => (
						<Checkbox
							key={option.key}
							value={option.key}
							label={option.label}
							description={option.description}
							size={FIELD_SIZE}
							{...testId(`popcorn-voice-${option.key}`)}
						/>
					))}
				</Stack>
			</Checkbox.Group>
			<Box>
				<Checkbox
					checked={otherOpen}
					onChange={(event) => {
						const open = event.currentTarget.checked;
						setOtherOpen(open);
						if (!open) onChange({ ...voice, note: "" });
					}}
					label={t`Something else`}
					description={t`Say it in your own words. Type, or press record and talk.`}
					size={FIELD_SIZE}
					{...testId("popcorn-voice-other")}
				/>
				{otherOpen ? (
					<Box mt="sm" pl="xl">
						<PricingTextInput
							minRows={1}
							onChange={(note) => onChange({ ...voice, note })}
							placeholder={t`For example: keep the members' own words, skip anything about named staff.`}
							projectId={projectId}
							questionKey="popcorn_voice"
							testIdPrefix="popcorn-voice"
							value={voice.note}
						/>
					</Box>
				) : null}
			</Box>
		</Stack>
	);
}

const EMPTY_VOICE: PopcornVoice = { note: "", presets: [] };

// The first meeting with popcorn, for a project that has not opted in yet.
// Says what it is, when to use it, and turns the beta on in one step. A short
// video can sit above the copy later.
function IntroModal({
	opened,
	projectId,
	onClose,
}: {
	opened: boolean;
	projectId: string;
	onClose: () => void;
}) {
	const updateProject = useUpdateProjectByIdMutation();
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Popcorn`}
			size="lg"
			{...testId("popcorn-intro-modal")}
		>
			<Stack gap="md">
				<Text>
					<Trans>
						Popcorn shows a room its own words while it is still talking: live
						slides made from this project's conversations, for a big screen.
					</Trans>
				</Text>
				<Text size="sm">
					<Trans>
						An early feature. It may change, and you can turn it off again in
						the project settings.
					</Trans>
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Not now</Trans>
					</Button>
					<Button
						loading={updateProject.isPending}
						onClick={() =>
							updateProject.mutate({
								id: projectId,
								payload: { is_canvas_enabled: true },
							})
						}
						{...testId("popcorn-intro-enable")}
					>
						<Trans>Turn on popcorn</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function PopcornStart({
	projectId,
	projectName,
}: {
	projectId: string;
	projectName: string;
}) {
	const [title, setTitle] = useState(projectName);
	const [duration, setDuration] = useState<Duration>("24h");
	const [voice, setVoice] = useState<PopcornVoice>(EMPTY_VOICE);
	const [trying, setTrying] = useState(false);
	const create = useCreatePopcornMutation(projectId);

	useEffect(() => {
		setTitle((current) => current || projectName);
	}, [projectName]);

	return (
		<PageContainer width="md">
			<Stack gap="lg">
				<Stack gap="xs">
					<Title order={2}>
						<Trans>Popcorn</Trans>
					</Title>
					<Text>
						<Trans>
							Live slides for the room, made from this project's conversations
							while they are still happening.
						</Trans>
					</Text>
				</Stack>
				{/* Try it: the upstream sample deck in the real viewer, no model call. */}
				<Paper
					withBorder
					className="rounded-md"
					p="md"
					{...testId("popcorn-try")}
				>
					<Group justify="space-between" align="center" wrap="wrap" gap="sm">
						<Text size="sm">
							<Trans>
								See what the room will see, with a sample session, before your
								own day.
							</Trans>
						</Text>
						<Button
							variant={trying ? "subtle" : "outline"}
							onClick={() => setTrying((current) => !current)}
							{...testId("popcorn-try-button")}
						>
							{trying ? t`Hide the sample` : t`Try it with a sample`}
						</Button>
					</Group>
					{trying ? (
						<Box
							mt="md"
							className="overflow-hidden rounded-md border"
							style={{
								borderColor: "var(--mantine-color-gray-3)",
								height: 560,
							}}
						>
							<iframe
								title={t`Sample popcorn session`}
								src={popcornSampleViewUrl()}
								className="block h-full w-full border-0"
								{...testId("popcorn-sample-frame")}
							/>
						</Box>
					) : null}
				</Paper>
				<Paper withBorder className="rounded-md" p="lg">
					<Stack gap="lg">
						<TextInput
							label={t`Session title`}
							description={t`Shown at the top of the screen. Change it any time.`}
							size={FIELD_SIZE}
							value={title}
							maxLength={160}
							onChange={(event) => setTitle(event.currentTarget.value)}
							{...testId("popcorn-title-input")}
						/>
						<Select
							label={t`Stay live for`}
							size={FIELD_SIZE}
							value={duration}
							onChange={(value) => setDuration((value as Duration) ?? "24h")}
							data={[
								{ label: t`8 hours`, value: "8h" },
								{ label: t`24 hours`, value: "24h" },
								{ label: t`3 days`, value: "3d" },
							]}
						/>
						<VoiceFields
							projectId={projectId}
							voice={voice}
							onChange={setVoice}
						/>
						<Group justify="flex-end">
							<Button
								radius="xl"
								size={FIELD_SIZE}
								loading={create.isPending}
								disabled={!title.trim()}
								onClick={() =>
									create.mutate({
										expires_at: expiryFor(duration).toISOString(),
										title: title.trim(),
										voice:
											voice.presets.length || voice.note.trim()
												? { note: voice.note.trim(), presets: voice.presets }
												: undefined,
									})
								}
								{...testId("popcorn-start-button")}
							>
								<Trans>Start popcorn</Trans>
							</Button>
						</Group>
					</Stack>
				</Paper>
			</Stack>
		</PageContainer>
	);
}

// Sharing, the way a video site does it: one switch to make the page public,
// then Link or Embed, each with the thing to copy right there.
function SharePopover({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const [opened, setOpened] = useState(false);
	const [mode, setMode] = useState<"link" | "embed">("link");
	const token = popcorn.public_token;
	const publicUrl = token ? popcornPublicUrl(token) : null;
	const isPublic = popcorn.settings.public && !!publicUrl;
	const embed = token ? popcornEmbedSnippet(token) : "";

	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			position="bottom-start"
			width={440}
			shadow="md"
		>
			<Popover.Target>
				<Button
					variant="outline"
					leftSection={<ShareNetworkIcon size={16} />}
					onClick={() => setOpened((current) => !current)}
					{...testId("popcorn-share-button")}
				>
					<Trans>Share</Trans>
				</Button>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="md">
					<Switch
						label={t`Public page`}
						description={t`Anyone with the link can watch. No login, and no transcripts.`}
						checked={popcorn.settings.public}
						disabled={settings.isPending}
						onChange={(event) =>
							settings.mutate({ public: event.currentTarget.checked })
						}
						{...testId("popcorn-public-toggle")}
					/>
					{isPublic && publicUrl ? (
						<Stack gap="sm">
							<SegmentedControl
								size="sm"
								value={mode}
								onChange={(value) => setMode(value as "link" | "embed")}
								data={[
									{ label: t`Link`, value: "link" },
									{ label: t`Embed`, value: "embed" },
								]}
								{...testId("popcorn-share-mode")}
							/>
							{mode === "link" ? (
								<Group gap="xs" wrap="nowrap">
									<TextInput
										value={publicUrl}
										readOnly
										className="min-w-0 flex-1"
										aria-label={t`Public link`}
										{...testId("popcorn-public-url")}
									/>
									<CopyButton value={publicUrl} timeout={2000}>
										{({ copied, copy }) => (
											<Button
												onClick={copy}
												leftSection={
													copied ? (
														<CheckIcon size={16} />
													) : (
														<CopyIcon size={16} />
													)
												}
												{...testId("popcorn-copy-link")}
											>
												{copied ? t`Copied` : t`Copy`}
											</Button>
										)}
									</CopyButton>
									<Tooltip label={t`Open in a new tab`}>
										<ActionIcon
											variant="outline"
											size="lg"
											component="a"
											href={publicUrl}
											target="_blank"
											rel="noopener noreferrer"
											aria-label={t`Open in a new tab`}
										>
											<ArrowSquareOutIcon size={16} />
										</ActionIcon>
									</Tooltip>
								</Group>
							) : (
								<Stack gap="xs">
									<Textarea
										value={embed}
										readOnly
										autosize
										minRows={3}
										styles={{
											input: { fontFamily: "monospace", fontSize: 12 },
										}}
										aria-label={t`Embed code`}
										{...testId("popcorn-embed-code")}
									/>
									<Group justify="space-between" align="center">
										<Text size="xs">
											<Trans>Paste it into any page. It stays live.</Trans>
										</Text>
										<CopyButton value={embed} timeout={2000}>
											{({ copied, copy }) => (
												<Button
													onClick={copy}
													leftSection={
														copied ? (
															<CheckIcon size={16} />
														) : (
															<CopyIcon size={16} />
														)
													}
													{...testId("popcorn-copy-embed")}
												>
													{copied ? t`Copied` : t`Copy`}
												</Button>
											)}
										</CopyButton>
									</Group>
								</Stack>
							)}
						</Stack>
					) : null}
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

// Everything about the session that is not what the room sees, in one place:
// its title, whether it keeps reading, how long it stays live, its voice, and
// the mark at the bottom of the screen.
function SessionModal({
	projectId,
	popcorn,
	opened,
	onClose,
}: {
	projectId: string;
	popcorn: PopcornDetail;
	opened: boolean;
	onClose: () => void;
}) {
	const { workspace } = useWorkspace();
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const loopSettings = usePopcornLoopSettingsMutation(projectId, popcorn.id);
	const lifecycle = usePopcornLifecycleMutation(projectId, popcorn.id);
	const refresh = useRefreshPopcornMutation(projectId, popcorn.id);
	const [title, setTitle] = useState(popcorn.settings.title);
	const [voice, setVoice] = useState<PopcornVoice>(
		popcorn.settings.voice ?? EMPTY_VOICE,
	);
	const [duration, setDuration] = useState<Duration | "keep">("keep");
	const [showBranding, setShowBranding] = useState(
		popcorn.settings.show_branding ?? true,
	);

	useEffect(() => {
		if (!opened) return;
		setTitle(popcorn.settings.title);
		setVoice(popcorn.settings.voice ?? EMPTY_VOICE);
		setDuration("keep");
		setShowBranding(popcorn.settings.show_branding ?? true);
	}, [opened, popcorn.settings]);

	const loopStatus = popcorn.loop?.status;
	const reading = loopStatus === "active";
	const isEnded = ["expired", "ended", "stopped"].includes(loopStatus ?? "");
	const canRemoveMark = meetsTier(workspace?.tier, "changemaker");
	const current = popcorn.settings.voice ?? EMPTY_VOICE;
	const voiceChanged =
		voice.note.trim() !== current.note ||
		voice.presets.join(",") !== current.presets.join(",");
	const busy =
		settings.isPending || loopSettings.isPending || lifecycle.isPending;

	const save = () => {
		settings.mutate(
			{
				show_branding: showBranding,
				title: title.trim(),
				voice: { note: voice.note.trim(), presets: voice.presets },
			},
			{
				onSuccess: () => {
					if (duration !== "keep" && popcorn.loop) {
						loopSettings.mutate({
							cadence_minutes: popcorn.loop.cadence_minutes ?? 2,
							expires_at: expiryFor(duration).toISOString(),
						});
					}
					onClose();
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Settings`}
			size="lg"
			{...testId("popcorn-session-modal")}
		>
			<Stack gap="lg">
				<TextInput
					label={t`Title`}
					description={t`Shown at the top of the screen.`}
					size={FIELD_SIZE}
					value={title}
					maxLength={160}
					onChange={(event) => setTitle(event.currentTarget.value)}
					{...testId("popcorn-title-edit-input")}
				/>
				{!isEnded ? (
					<Switch
						size={FIELD_SIZE}
						label={t`Keep reading new conversations`}
						description={t`Off freezes the screen exactly as it is, for example while you talk it through. On picks up where it left off.`}
						checked={reading}
						disabled={lifecycle.isPending}
						onChange={(event) =>
							lifecycle.mutate(event.currentTarget.checked ? "resume" : "pause")
						}
						{...testId("popcorn-reading-toggle")}
					/>
				) : null}
				{!isEnded ? (
					<Group gap="sm" align="center" wrap="wrap">
						<Button
							variant="outline"
							size="xs"
							loading={refresh.isPending}
							onClick={() => refresh.mutate()}
							{...testId("popcorn-refresh-button")}
						>
							<Trans>Read everything again now</Trans>
						</Button>
						<Text size="xs">
							<Trans>
								Rarely needed: new conversations are picked up on their own. Use
								it after changing the voice.
							</Trans>
						</Text>
					</Group>
				) : null}
				<Select
					label={t`Stays live until`}
					size={FIELD_SIZE}
					value={duration}
					onChange={(value) =>
						setDuration((value as Duration | "keep") ?? "keep")
					}
					data={[
						{
							label: popcorn.loop?.expires_at
								? format(new Date(popcorn.loop.expires_at), "EEE d MMM, HH:mm")
								: t`As now`,
							value: "keep",
						},
						{ label: t`8 more hours`, value: "8h" },
						{ label: t`24 more hours`, value: "24h" },
						{ label: t`3 more days`, value: "3d" },
					]}
				/>
				<VoiceFields projectId={projectId} voice={voice} onChange={setVoice} />
				{voiceChanged ? (
					<Text size="sm">
						<Trans>Changing the voice re-reads every conversation.</Trans>
					</Text>
				) : null}
				{canRemoveMark ? (
					<Switch
						size={FIELD_SIZE}
						label={t`Show "made with dembrane" on the screen`}
						description={t`Your plan lets you take the mark off.`}
						checked={showBranding}
						onChange={(event) => setShowBranding(event.currentTarget.checked)}
						{...testId("popcorn-branding-toggle")}
					/>
				) : (
					<Group
						gap="xs"
						align="center"
						wrap="wrap"
						{...testId("popcorn-branding-note")}
					>
						<Text size="sm">
							<Trans>"made with dembrane" stays on the screen.</Trans>
						</Text>
						<Badge size="sm" variant="outline">
							<Trans>Changemaker plan takes it off</Trans>
						</Badge>
					</Group>
				)}
				<Group justify="flex-end" gap="xs">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						loading={settings.isPending || loopSettings.isPending}
						disabled={!title.trim() || busy}
						onClick={save}
						{...testId("popcorn-title-save")}
					>
						<Trans>Save</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function versionLabel(version: PopcornVersion): string {
	const date = new Date(version.created_at);
	if (Number.isNaN(date.getTime())) return t`Version`;
	return format(date, "HH:mm");
}

// Every run that changed the deck is kept. Picking one replays it in the
// viewer, phrases popping in as they did; Live returns to the running session.
function VersionStrip({
	versions,
	selected,
	onSelect,
}: {
	versions: PopcornVersion[];
	selected: string | null;
	onSelect: (id: string | null) => void;
}) {
	if (versions.length === 0) return null;
	return (
		<Group gap="xs" align="center" wrap="wrap" {...testId("popcorn-versions")}>
			<Text size="sm" fw={500}>
				<Trans>Replay</Trans>
			</Text>
			<Button
				size="xs"
				variant={selected ? "subtle" : "outline"}
				onClick={() => onSelect(null)}
				{...testId("popcorn-version-live")}
			>
				<Trans>Live</Trans>
			</Button>
			{versions.slice(0, 12).map((version) => (
				<Tooltip
					key={version.id}
					label={version.detail ?? ""}
					multiline
					w={360}
				>
					<Button
						size="xs"
						variant={selected === version.id ? "outline" : "subtle"}
						style={{ fontVariantNumeric: "tabular-nums" }}
						onClick={() => onSelect(version.id)}
						{...testId(`popcorn-version-${version.id}`)}
					>
						{versionLabel(version)}
					</Button>
				</Tooltip>
			))}
		</Group>
	);
}

type HostSettingsMessage = {
	type: "dembrane:popcorn:settings";
	patch: { tabs?: Record<string, boolean>; show_qr?: boolean };
};

function isHostSettingsMessage(data: unknown): data is HostSettingsMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { type?: unknown }).type === "dembrane:popcorn:settings" &&
		typeof (data as { patch?: unknown }).patch === "object"
	);
}

function PopcornSession({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const versionsQuery = usePopcornVersions(popcorn.id);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const [sessionOpened, sessionModal] = useDisclosure(false);
	const invalidate = useInvalidatePopcorn(projectId);
	const {
		ref: fullscreenRef,
		toggle: toggleFullscreen,
		fullscreen,
	} = useFullscreen();
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	useDocumentTitle(`${popcorn.name} | dembrane`);

	// Fullscreen is the wall. Tell the deck, so it drops the host affordances
	// and shows exactly what the public page shows.
	useEffect(() => {
		frameRef.current?.contentWindow?.postMessage(
			{ type: "dembrane:popcorn:presenting", value: fullscreen },
			"*",
		);
	}, [fullscreen]);

	const loopStatus = popcorn.loop?.status;
	const isEnded = ["expired", "ended", "stopped"].includes(loopStatus ?? "");

	// The deck polls its own data; this stream only keeps the counts and the
	// status line in step with the tick.
	useEffect(() => {
		let source: EventSource | null = null;
		let closed = false;
		let reconnectTimer: number | null = null;
		let retryMs = 1000;
		const connect = () => {
			if (closed) return;
			source = new EventSource(
				`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(popcorn.id)}/events`,
				{ withCredentials: true },
			);
			source.addEventListener("connected", () => {
				retryMs = 1000;
			});
			source.addEventListener("update", () => {
				invalidate();
			});
			source.onerror = () => {
				source?.close();
				source = null;
				if (closed) return;
				reconnectTimer = window.setTimeout(connect, retryMs);
				retryMs = Math.min(retryMs * 2, 15000);
			};
		};
		connect();
		return () => {
			closed = true;
			if (reconnectTimer) window.clearTimeout(reconnectTimer);
			source?.close();
		};
	}, [popcorn.id, invalidate]);

	// What the room sees is changed on the preview itself: the deck posts a
	// settings patch when the host hides a tab or takes the QR code down.
	const mutateSettings = settings.mutate;
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!isHostSettingsMessage(event.data)) return;
			mutateSettings(event.data.patch);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [mutateSettings]);

	const viewUrl = useMemo(
		() => popcornHostViewUrl(popcorn.id, selectedVersion ?? undefined),
		[popcorn.id, selectedVersion],
	);
	// Present: the one button for the minute before the wall. Publishes, puts
	// the QR up, and goes fullscreen, in that order, so the room's link works
	// the moment the screen is large.
	const present = () => {
		const patch: Record<string, boolean> = {};
		if (!popcorn.settings.public) patch.public = true;
		if (!popcorn.settings.show_qr) patch.show_qr = true;
		if (Object.keys(patch).length) settings.mutate(patch);
		if (!fullscreen) toggleFullscreen();
	};

	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md">
				{/* Two rows, always: what this is, then what you can do with it. */}
				<Stack gap={2} className="min-w-0">
					<Group gap="sm" align="center" wrap="nowrap">
						<Title order={2} className="truncate">
							{popcorn.name}
						</Title>
						<Badge size="sm" variant="light" color="primary">
							<Trans>Beta</Trans>
						</Badge>
					</Group>
					<Text size="sm" {...testId("popcorn-status-line")}>
						{statusLine(popcorn)}
					</Text>
				</Stack>
				<Group gap="xs" wrap="wrap" {...testId("popcorn-actions")}>
					{/* The one pill on the page: the primary action. */}
					<Button
						radius="xl"
						leftSection={<PresentationIcon size={16} />}
						loading={settings.isPending}
						disabled={isEnded}
						onClick={present}
						{...testId("popcorn-present-button")}
					>
						<Trans>Present</Trans>
					</Button>
					<SharePopover projectId={projectId} popcorn={popcorn} />
					<Button
						variant="outline"
						leftSection={<PencilSimpleIcon size={16} />}
						onClick={sessionModal.open}
						{...testId("popcorn-title-edit-button")}
					>
						<Trans>Settings</Trans>
					</Button>
				</Group>
				<VersionStrip
					versions={versionsQuery.data ?? []}
					selected={selectedVersion}
					onSelect={setSelectedVersion}
				/>
				{selectedVersion ? (
					<Alert variant="light" {...testId("popcorn-replay-banner")}>
						<Trans>
							Replaying a saved run. The room's page and the public link keep
							showing the live session.
						</Trans>
					</Alert>
				) : null}
				<Box
					ref={fullscreenRef}
					className="overflow-hidden rounded-md border"
					style={{
						backgroundColor: "var(--app-background)",
						borderColor: "var(--mantine-color-gray-3)",
						height: fullscreen ? "100vh" : "calc(100vh - 300px)",
						minHeight: 520,
					}}
				>
					<iframe
						ref={frameRef}
						title={popcorn.name}
						src={viewUrl}
						className="block h-full w-full border-0"
						allowFullScreen
						{...testId("popcorn-frame")}
					/>
				</Box>
				<Text size="xs" {...testId("popcorn-preview-hint")}>
					<Trans>
						Only you see these controls: hover a tab to hide it, use the stage
						corner for the QR code, click a phrase to see where it came from.
					</Trans>
				</Text>
			</Stack>
			<SessionModal
				projectId={projectId}
				popcorn={popcorn}
				opened={sessionOpened}
				onClose={sessionModal.close}
			/>
		</PageContainer>
	);
}

function PopcornLoading() {
	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md">
				<Stack gap="xs">
					<Skeleton height={32} width={280} />
					<Skeleton height={16} width={320} />
				</Stack>
				<Group gap="xs">
					<Skeleton height={36} width={120} radius="xl" />
					<Skeleton height={36} width={96} radius="md" />
					<Skeleton height={36} width={110} radius="md" />
				</Group>
				<Skeleton height={520} radius="md" />
			</Stack>
		</PageContainer>
	);
}

export const PopcornRoute = () => {
	const { projectId, workspaceId } = useParams<{
		projectId: string;
		workspaceId: string;
	}>();
	const navigate = useI18nNavigate();
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name", "is_canvas_enabled"] },
	});
	const canvasEnabled = !!projectQuery.data?.is_canvas_enabled;
	const popcornQuery = useProjectPopcorn(
		canvasEnabled ? (projectId ?? "") : "",
	);

	if (!ENABLE_CANVAS || !projectId) return null;
	if (projectQuery.isLoading) return <PopcornLoading />;
	if (!canvasEnabled) {
		return (
			<IntroModal
				opened
				projectId={projectId}
				onClose={() => navigate(`/w/${workspaceId}/projects/${projectId}/home`)}
			/>
		);
	}
	if (popcornQuery.isLoading) return <PopcornLoading />;
	if (popcornQuery.isError) {
		return (
			<PageContainer width="md">
				<Text>
					<Trans>Popcorn could not be loaded. Try again in a moment.</Trans>
				</Text>
			</PageContainer>
		);
	}
	const popcorn = popcornQuery.data;
	if (!popcorn) {
		return (
			<PopcornStart
				projectId={projectId}
				projectName={projectQuery.data?.name ?? ""}
			/>
		);
	}
	return <PopcornSession projectId={projectId} popcorn={popcorn} />;
};
