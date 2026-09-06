import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Menu,
	Modal,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	BroadcastIcon,
	CaretDownIcon,
	ProjectorScreenIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
	type LiveHours,
	type PopcornDetail,
	popcornPresenterUrl,
	useInvalidatePopcorn,
	usePopcornLiveMutation,
	usePopcornStopLiveMutation,
	useRefreshPopcornMutation,
	useRerunPopcornMutation,
} from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";

const DELAYED_AFTER_SECONDS = 60;

function countdown(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const sec = seconds % 60;
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

// While live: the clock to the next read, and the way out. A read that is a
// minute late has most likely been stranded on the server; the chip says so,
// and Refresh is the way to read.
function LiveChip({
	popcorn,
	onStale,
	onStop,
	pending,
}: {
	popcorn: PopcornDetail;
	onStale: () => void;
	onStop: () => void;
	pending: boolean;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const loop = popcorn.loop;
	const counts = popcorn.counts;
	const next = loop?.next_read_at
		? new Date(loop.next_read_at).getTime()
		: null;
	const seconds = next ? Math.ceil((next - now) / 1000) : null;
	const overdue = seconds !== null && seconds <= 0;
	const delayed = seconds !== null && seconds <= -DELAYED_AFTER_SECONDS;
	useEffect(() => {
		if (!overdue) return;
		const timer = window.setInterval(onStale, 4000);
		return () => window.clearInterval(timer);
	}, [overdue, onStale]);

	const reading = counts.reading ?? 0;
	let label: string;
	if (delayed) label = t`Live · the last read is late`;
	else if (reading > 0)
		label = t`Live · reading ${reading} of ${counts.conversations}…`;
	else if (seconds === null || overdue) label = t`Live · reading now…`;
	else label = t`Live · next read in ${countdown(seconds)}`;

	return (
		<Group gap={4} wrap="nowrap">
			<Tooltip label={t`Reads every 2 minutes. Refresh reads now.`}>
				<Button
					variant="light"
					color="red"
					style={{ cursor: "default", fontVariantNumeric: "tabular-nums" }}
					leftSection={
						<span
							className="inline-block h-2 w-2 animate-pulse rounded-full bg-current"
							aria-hidden
						/>
					}
					{...testId("popcorn-live-badge")}
				>
					{label}
				</Button>
			</Tooltip>
			<Button
				variant="subtle"
				color="red"
				loading={pending}
				onClick={onStop}
				{...testId("popcorn-stop-live")}
			>
				<Trans>Stop live</Trans>
			</Button>
		</Group>
	);
}

// What a host can do with a session: open the wall, read once, read from
// nothing, or go live for a while.
export function PopcornActions({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const refresh = useRefreshPopcornMutation(projectId, popcorn.id);
	const rerun = useRerunPopcornMutation(projectId, popcorn.id);
	const live = usePopcornLiveMutation(projectId, popcorn.id);
	const stopLive = usePopcornStopLiveMutation(projectId, popcorn.id);
	const invalidate = useInvalidatePopcorn(projectId);
	const [rerunOpened, rerunModal] = useDisclosure(false);
	const isLive = popcorn.loop?.mode === "live";
	const hours: { value: LiveHours; label: string }[] = [
		{ label: t`1 hour`, value: 1 },
		{ label: t`8 hours`, value: 8 },
		{ label: t`24 hours`, value: 24 },
	];

	return (
		<Group gap="xs" wrap="wrap" {...testId("popcorn-actions")}>
			<Button
				size="md"
				component="a"
				href={popcornPresenterUrl(popcorn.id)}
				target="_blank"
				rel="noopener noreferrer"
				leftSection={<ProjectorScreenIcon size={18} />}
				{...testId("popcorn-open-presenter")}
			>
				<Trans>Open presenter view</Trans>
			</Button>
			<Button
				variant="outline"
				leftSection={<ArrowsClockwiseIcon size={16} />}
				loading={refresh.isPending}
				onClick={() => refresh.mutate()}
				{...testId("popcorn-refresh-button")}
			>
				<Trans>Refresh</Trans>
			</Button>
			<Button
				variant="outline"
				leftSection={<ArrowCounterClockwiseIcon size={16} />}
				onClick={rerunModal.open}
				{...testId("popcorn-rerun-button")}
			>
				<Trans>Rerun</Trans>
			</Button>
			{isLive ? (
				<LiveChip
					popcorn={popcorn}
					onStale={invalidate}
					onStop={() => stopLive.mutate()}
					pending={stopLive.isPending}
				/>
			) : (
				<Menu position="bottom-start" shadow="md" width={220}>
					<Menu.Target>
						<Button
							variant="gradient"
							gradient={{ deg: 90, from: "primary", to: "red" }}
							leftSection={<BroadcastIcon size={16} />}
							rightSection={<CaretDownIcon size={14} />}
							loading={live.isPending}
							{...testId("popcorn-live-button")}
						>
							<Trans>Go live</Trans>
						</Button>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Label>
							<Trans>Read every 2 minutes for</Trans>
						</Menu.Label>
						{hours.map((option) => (
							<Menu.Item
								key={option.value}
								onClick={() => live.mutate(option.value)}
								{...testId(`popcorn-live-${option.value}h`)}
							>
								{option.label}
							</Menu.Item>
						))}
					</Menu.Dropdown>
				</Menu>
			)}
			<Modal
				opened={rerunOpened}
				onClose={rerunModal.close}
				title={t`Rerun popcorn?`}
				{...testId("popcorn-rerun-modal")}
			>
				<Stack gap="md">
					<Text>
						<Trans>
							This replaces every popcorn, tension and stakeholder on the screen
							and reads all conversations again. Earlier runs are saved in the
							history.
						</Trans>
					</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={rerunModal.close}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							color="red"
							loading={rerun.isPending}
							onClick={() =>
								rerun.mutate(undefined, { onSuccess: rerunModal.close })
							}
							{...testId("popcorn-rerun-confirm")}
						>
							<Trans>Rerun</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Group>
	);
}
