import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Box, Group, Text } from "@mantine/core";
import { Fragment } from "react";
import { testId } from "@/lib/testUtils";

/** The one live mark: red means "this is moving now", and nothing else is. */
export function LiveDot() {
	return (
		<Box
			component="span"
			aria-hidden
			bg="red.7"
			w={8}
			h={8}
			className="inline-block shrink-0 rounded-full motion-safe:animate-pulse"
		/>
	);
}

/** A moment as a host reads it: "18:00" today, "Sat 4 Oct, 09:00" otherwise. */
export function formatWhen(when: Date, locale: string, now = new Date()) {
	const time: Intl.DateTimeFormatOptions = {
		hour: "2-digit",
		minute: "2-digit",
	};
	return when.toDateString() === now.toDateString()
		? when.toLocaleTimeString(locale, time)
		: when.toLocaleString(locale, {
				...time,
				day: "numeric",
				month: "short",
				weekday: "short",
			});
}

const validDate = (value?: string | null) => {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** A report's state in a word, for the report and for project home. */
export function reportStatusLabel(status: string) {
	switch (status) {
		case "published":
			return t`Published`;
		case "scheduled":
			return t`Scheduled`;
		case "draft":
			return t`Generating`;
		default:
			return t`Archived`;
	}
}

/**
 * The share panel read aloud, under an outcome's title: live or once first,
 * then who can see it, then anything the outcome adds.
 */
export function StatusLine({
	live,
	liveUntil,
	onceAt,
	isPublic,
	extra = [],
}: {
	live?: boolean;
	liveUntil?: string | null;
	onceAt?: string | null;
	isPublic: boolean;
	extra?: string[];
}) {
	const { i18n } = useLingui();
	const until = validDate(liveUntil);
	const once = validDate(onceAt);
	const parts = [
		once && t`Updates once at ${formatWhen(once, i18n.locale)}`,
		isPublic ? t`Public page` : t`Private`,
		...extra,
	].filter((part): part is string => !!part);
	return (
		<Group gap="xs" wrap="wrap" role="status" {...testId("status-line")}>
			{live && (
				<Group gap="xs" wrap="nowrap">
					<LiveDot />
					<Text size="sm">
						{until ? t`Live until ${formatWhen(until, i18n.locale)}` : t`Live`}
					</Text>
				</Group>
			)}
			{parts.map((part, index) => (
				<Fragment key={part}>
					{(live || index > 0) && (
						<Text size="sm" c="dimmed" aria-hidden>
							·
						</Text>
					)}
					<Text size="sm" c="dimmed">
						{part}
					</Text>
				</Fragment>
			))}
		</Group>
	);
}
