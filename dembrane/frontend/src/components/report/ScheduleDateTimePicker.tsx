import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Stack, Text } from "@mantine/core";
import { DatePickerInput, TimeInput } from "@mantine/dates";
import { useRef } from "react";

/** Returns a Date 10 minutes from now (rounded up to next 5-min mark). */
function getMinScheduleDate(): Date {
	const d = new Date(Date.now() + 10 * 60_000);
	const mins = d.getMinutes();
	const remainder = mins % 5;
	if (remainder !== 0) d.setMinutes(mins + (5 - remainder), 0, 0);
	return d;
}

/** 30 days from now. */
function getMaxScheduleDate(): Date {
	return new Date(Date.now() + 30 * 24 * 60 * 60_000);
}

/** Combine a date and a time string (HH:mm) into a single Date. */
function combineDateTime(date: Date | null, time: string): Date | null {
	if (!date || !time) return null;
	const [hours, minutes] = time.split(":").map(Number);
	if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
	const combined = new Date(date);
	combined.setHours(hours, minutes, 0, 0);
	return combined;
}

/** Check if a date is at least 10 minutes in the future. */
function isDateFarEnough(date: Date | null): boolean {
	if (!date) return false;
	return date.getTime() > Date.now() + 10 * 60_000;
}

/** Format a Date to HH:mm string. */
function formatTime(date: Date | null): string {
	if (!date) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface ScheduleDateTimePickerProps {
	value: Date | null;
	onChange: (value: Date | null) => void;
	label?: string;
}

export function ScheduleDateTimePicker({
	value,
	onChange,
	label,
}: ScheduleDateTimePickerProps) {
	const timeRef = useRef<HTMLInputElement>(null);
	const minDate = getMinScheduleDate();

	const dateValue = value
		? new Date(value.getFullYear(), value.getMonth(), value.getDate())
		: null;
	const timeValue = value ? formatTime(value) : "";

	const handleDateChange = (date: Date | null) => {
		if (!date) {
			onChange(null);
			return;
		}
		// If time is already set, combine; otherwise default to the min schedule time
		const time = timeValue || formatTime(minDate);
		onChange(combineDateTime(date, time));
	};

	const handleTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const time = event.currentTarget.value;
		if (!dateValue) return;
		onChange(combineDateTime(dateValue, time));
	};

	const tooSoon = value && !isDateFarEnough(value);

	return (
		<Stack gap="xs">
			{label && (
				<Text size="sm" fw={500}>
					{label}
				</Text>
			)}
			<Group gap="sm" grow>
				<DatePickerInput
					label={t`Date`}
					placeholder={t`Pick a date`}
					value={dateValue}
					onChange={handleDateChange}
					minDate={minDate}
					maxDate={getMaxScheduleDate()}
					clearable
				/>
				<TimeInput
					ref={timeRef}
					label={t`Time`}
					value={timeValue}
					onChange={handleTimeChange}
					minTime={
						dateValue && dateValue.toDateString() === new Date().toDateString()
							? formatTime(minDate)
							: undefined
					}
				/>
			</Group>
			{tooSoon && (
				<Text size="xs" c="red">
					<Trans>Must be at least 10 minutes in the future</Trans>
				</Text>
			)}
		</Stack>
	);
}

export { isDateFarEnough };
