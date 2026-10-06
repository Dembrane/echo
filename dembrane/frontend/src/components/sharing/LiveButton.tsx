import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Menu, Stack, Text } from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import {
	BroadcastIcon,
	CaretDownIcon,
	CheckIcon,
	ClockIcon,
	PlayIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { LiveBooking, LiveHours } from "@/components/popcorn/hooks";
import { formatWhen } from "@/components/sharing/StatusLine";
import { testId } from "@/lib/testUtils";

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

/** The first full hour at least half an hour away, as HH:MM. */
export function defaultReadyTime(now = new Date()) {
	const at = new Date(now.getTime() + 30 * 60_000);
	if (at.getMinutes() || at.getSeconds() || at.getMilliseconds())
		at.setHours(at.getHours() + 1, 0, 0, 0);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Go live now or be ready by a time, for the hours chosen below. Stop live
 * takes Go live's place while live; a booked start shows its time on the
 * button and the same menu, with Cancel.
 */
export function LiveButton({
	live,
	pending,
	booking = null,
	onGoLive,
	onReadyBy,
	onStop,
}: {
	live: boolean;
	pending: boolean;
	booking?: LiveBooking | null;
	onGoLive: (hours: LiveHours) => void;
	onReadyBy: (hours: LiveHours, readyBy: Date) => void;
	/** Stops live, or cancels a booked start. */
	onStop: () => void;
}) {
	const { i18n } = useLingui();
	const [opened, setOpened] = useState(false);
	const [hours, setHours] = useState<LiveHours>(8);
	const [time, setTime] = useState(defaultReadyTime);

	if (live)
		return (
			<Button
				leftSection={<BroadcastIcon size={20} />}
				loading={pending}
				onClick={onStop}
				{...testId("live-stop")}
			>
				<Trans>Stop live</Trans>
			</Button>
		);

	const readyBy = readyByFrom(time);
	const startsAt = readyBy
		? new Date(readyBy.getTime() - READY_LEAD_MINUTES * 60_000)
		: null;
	const book = () => {
		if (!readyBy) return;
		onReadyBy(hours, readyBy);
		setOpened(false);
	};
	const durations: { value: LiveHours; label: string }[] = [
		{ label: t`1 hour`, value: 1 },
		{ label: t`8 hours`, value: 8 },
		{ label: t`24 hours`, value: 24 },
	];
	const bookedFor = booking ? new Date(booking.readyBy) : null;
	const readyTime = bookedFor ? formatWhen(bookedFor, i18n.locale) : "";
	const startTime = startsAt ? formatWhen(startsAt, i18n.locale) : "";
	// Under 15 minutes away there is no early start left: it goes live at once.
	const startsNow = !!startsAt && startsAt.getTime() <= Date.now();

	return (
		<Menu
			position="bottom-start"
			opened={opened}
			onChange={setOpened}
			closeOnItemClick
		>
			<Menu.Target>
				{bookedFor ? (
					<Button
						variant="outline"
						leftSection={<ClockIcon size={20} />}
						rightSection={<CaretDownIcon size={16} />}
						loading={pending}
						{...testId("live-booked")}
					>
						{t`Ready by ${readyTime}`}
					</Button>
				) : (
					<Button
						leftSection={<BroadcastIcon size={20} />}
						rightSection={<CaretDownIcon size={16} />}
						loading={pending}
						{...testId("live-go")}
					>
						<Trans>Go live</Trans>
					</Button>
				)}
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item
					leftSection={<PlayIcon size={16} />}
					onClick={() => onGoLive(hours)}
					{...testId("live-start-now")}
				>
					<Trans>Start now</Trans>
				</Menu.Item>
				{/* The menu's arrow keys stay out of the field. */}
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
				<Menu.Divider />
				<Menu.Label>
					<Trans>Stay live for</Trans>
				</Menu.Label>
				{durations.map((option) => (
					<Menu.Item
						key={option.value}
						closeMenuOnClick={false}
						rightSection={
							hours === option.value ? (
								<CheckIcon size={16} role="img" aria-label={t`Selected`} />
							) : null
						}
						onClick={() => setHours(option.value)}
						{...testId(`live-${option.value}h`)}
					>
						{option.label}
					</Menu.Item>
				))}
				{booking && (
					<>
						<Menu.Divider />
						<Menu.Item
							c="dimmed"
							onClick={onStop}
							{...testId("live-cancel-booking")}
						>
							<Trans>Cancel</Trans>
						</Menu.Item>
					</>
				)}
			</Menu.Dropdown>
		</Menu>
	);
}
