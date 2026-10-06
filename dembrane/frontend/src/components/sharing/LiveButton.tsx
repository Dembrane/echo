import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Menu, Stack, Text } from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import {
	ArrowsClockwiseIcon,
	BroadcastIcon,
	CaretDownIcon,
	CheckIcon,
	PlayIcon,
	StopIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { LiveBooking, LiveHours } from "@/components/popcorn/hooks";
import { formatWhen } from "@/components/sharing/StatusLine";
import { testId } from "@/lib/testUtils";
import classes from "./LiveButton.module.css";

/** The first read of a booked start comes this long before the time asked for. */
export const READY_LEAD_MINUTES = 15;

/** "14:30" as the next 14:30: today, or tomorrow when it has passed. */
export function readyByFrom(time: string, now = new Date()): Date | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	const at = new Date(now);
	at.setHours(hours, minutes, 0, 0);
	if (at <= now) at.setDate(at.getDate() + 1);
	return at;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The first full hour at least half an hour away, as HH:MM. */
export function defaultReadyTime(now = new Date()) {
	const at = new Date(now.getTime() + 30 * 60_000);
	if (at.getMinutes() || at.getSeconds() || at.getMilliseconds())
		at.setHours(at.getHours() + 1, 0, 0, 0);
	return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A booked time as the field shows it, HH:MM. */
const fieldTime = (iso: string) => {
	const at = new Date(iso);
	return Number.isNaN(at.getTime())
		? defaultReadyTime()
		: `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * What the Analyse and Present split buttons share: the hours to stay live
 * for, the Ready by field with Book, and the open state of the chevron's
 * menu. Before live the hours are a choice the main part and Book use; while
 * live each one goes live again for that long from now.
 */
export function useLiveChoices({
	live,
	booking,
	onGoLive,
	onReadyBy,
}: {
	live: boolean;
	booking: LiveBooking | null;
	onGoLive: (hours: LiveHours) => void;
	onReadyBy: (hours: LiveHours, readyBy: Date) => void;
}) {
	const { i18n } = useLingui();
	const [opened, setOpened] = useState(false);
	const [hours, setHours] = useState<LiveHours>(8);
	const [time, setTime] = useState(() =>
		booking ? fieldTime(booking.readyBy) : defaultReadyTime(),
	);

	const durations: { value: LiveHours; label: string }[] = [
		{ label: t`1 hour`, value: 1 },
		{ label: t`8 hours`, value: 8 },
		{ label: t`24 hours`, value: 24 },
	];

	const readyBy = readyByFrom(time);
	const startsAt = readyBy
		? new Date(readyBy.getTime() - READY_LEAD_MINUTES * 60_000)
		: null;
	const book = () => {
		if (!readyBy) return;
		onReadyBy(hours, readyBy);
		setOpened(false);
	};
	const startTime = startsAt ? formatWhen(startsAt, i18n.locale) : "";
	// Under 15 minutes away there is no early start left: it goes live at once.
	const startsNow = !!startsAt && startsAt.getTime() <= Date.now();

	const readyByField = (
		// The menu's arrow keys stay out of the field.
		<Box px="sm" py="xs" onKeyDown={(event) => event.stopPropagation()}>
			<Stack gap={4}>
				<Group gap="xs" align="flex-end" wrap="nowrap">
					<TimeInput
						label={t`Ready by`}
						value={time}
						onChange={(event) => setTime(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") book();
						}}
						{...testId("live-ready-time")}
					/>
					<Button
						disabled={!readyBy}
						onClick={book}
						{...testId("live-ready-book")}
					>
						<Trans>Book</Trans>
					</Button>
				</Group>
				{startsAt && (
					<Text size="sm" c="dimmed" {...testId("live-ready-starts")}>
						{startsNow
							? t`Starts now`
							: t`Starts at ${startTime}, 15 minutes early`}
					</Text>
				)}
			</Stack>
		</Box>
	);

	const stayLiveFor = (
		<>
			<Menu.Label>
				<Trans>Stay live for</Trans>
			</Menu.Label>
			{durations.map((option) => (
				<Menu.Item
					key={option.value}
					closeMenuOnClick={live}
					rightSection={
						!live && hours === option.value ? (
							<CheckIcon size={16} role="img" aria-label={t`Selected`} />
						) : null
					}
					onClick={() => {
						setHours(option.value);
						if (live) onGoLive(option.value);
					}}
					{...testId(`live-${option.value}h`)}
				>
					{option.label}
				</Menu.Item>
			))}
		</>
	);

	return { hours, opened, readyByField, setOpened, stayLiveFor };
}

/**
 * The Analyse split button. The main part does the default for the state:
 * Analyse goes live now for the hours chosen, Start now replaces a booked
 * start by going live now, and Stop live ends live. The chevron opens the
 * other ways: Start now, Ready by a time, how long to stay live, Cancel a
 * booking, or Analyse now while live.
 */
export function LiveButton({
	live,
	pending,
	booking = null,
	onGoLive,
	onReadyBy,
	onStop,
	onAnalyseNow,
}: {
	live: boolean;
	pending: boolean;
	booking?: LiveBooking | null;
	/** Live from now for the hours; while live it restarts the hours from now. */
	onGoLive: (hours: LiveHours) => void;
	onReadyBy: (hours: LiveHours, readyBy: Date) => void;
	/** Stops live, or cancels a booked start. */
	onStop: () => void;
	/** One read straight away, as Refresh does. */
	onAnalyseNow: () => void;
}) {
	const { hours, opened, readyByField, setOpened, stayLiveFor } =
		useLiveChoices({ booking, live, onGoLive, onReadyBy });
	const booked = !live && !!booking;
	const state = live ? classes.live : booked ? classes.booked : "";

	const main = live ? (
		<Button
			variant="outline"
			color="red"
			className={classes.main}
			leftSection={<StopIcon size={20} />}
			loading={pending}
			onClick={onStop}
			{...testId("live-stop")}
		>
			<Trans>Stop live</Trans>
		</Button>
	) : booked ? (
		<Button
			variant="outline"
			color="gray"
			className={classes.main}
			leftSection={<PlayIcon size={20} />}
			loading={pending}
			onClick={() => onGoLive(hours)}
			{...testId("live-booked")}
		>
			<Trans>Start now</Trans>
		</Button>
	) : (
		<Button
			variant="filled"
			className={classes.main}
			leftSection={<BroadcastIcon size={20} />}
			loading={pending}
			onClick={() => onGoLive(hours)}
			{...testId("live-go")}
		>
			<Trans>Analyse</Trans>
		</Button>
	);

	return (
		<div className={`${classes.split} ${state}`} {...testId("live-split")}>
			{main}
			<Menu
				position="bottom-end"
				opened={opened}
				onChange={setOpened}
				closeOnItemClick
			>
				<Menu.Target>
					<Button
						variant={live || booked ? "outline" : "filled"}
						color={live ? "red" : booked ? "gray" : undefined}
						className={classes.more}
						aria-label={t`More ways to analyse`}
						{...testId("live-more")}
					>
						<CaretDownIcon size={16} />
					</Button>
				</Menu.Target>
				<Menu.Dropdown>
					{live ? (
						<>
							<Menu.Item
								leftSection={<ArrowsClockwiseIcon size={16} />}
								onClick={onAnalyseNow}
								{...testId("live-analyse-now")}
							>
								<Trans>Analyse now</Trans>
							</Menu.Item>
							<Menu.Divider />
							{stayLiveFor}
						</>
					) : booked ? (
						<>
							{readyByField}
							<Menu.Divider />
							{stayLiveFor}
							<Menu.Divider />
							<Menu.Item
								c="dimmed"
								onClick={onStop}
								{...testId("live-cancel-booking")}
							>
								<Trans>Cancel</Trans>
							</Menu.Item>
						</>
					) : (
						<>
							<Menu.Item
								leftSection={<PlayIcon size={16} />}
								onClick={() => onGoLive(hours)}
								{...testId("live-start-now")}
							>
								<Trans>Start now</Trans>
							</Menu.Item>
							{readyByField}
							<Menu.Divider />
							{stayLiveFor}
						</>
					)}
				</Menu.Dropdown>
			</Menu>
		</div>
	);
}
