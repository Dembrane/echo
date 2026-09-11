import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import { type BookingSignal, useCalEmbed } from "@/components/booking/calEmbed";
import {
	BookingHost,
	type BookingHostInfo,
	type BookingLinkSet,
	BookingLinks,
} from "@/lib/links";
import { testId } from "@/lib/testUtils";
import { bookingLinkWithPrefill } from "./bookingPrefill";

export type { BookingSignal };

/** The booking step: the cal.com embed, and the plain link when it does not come.
 *
 * The mechanics (the stub, the script, the eight second fallback clock) live in
 * `@/components/booking/calEmbed`, shared with the participant portal's closing
 * card. This file is what is particular to the configurator: the "discuss your
 * needs" event type, the answers as prefill, the reference, and the words.
 *
 * Both routes carry the answers. The embed gets them in its `config`, the plain
 * link gets the same map on its query string. See `bookingPrefill.ts` for the
 * keys and where each one is documented.
 */

const EMBED_ELEMENT_ID = "dembrane-cal-booking";

/** The name the two booking lines say.
 *
 * `BookingHost` is the one source, and null is a supported state: with no host
 * the screen says "the dembrane team".
 *
 * Call it during a render. A `t` macro at module scope freezes the string
 * before a locale is active.
 */
export const bookingHostName = (
	host: BookingHostInfo | null = BookingHost,
): string => host?.name ?? t`the dembrane team`;

export const PricingBookingStep = ({
	host: hostInfo = BookingHost,
	links = BookingLinks,
	onBooked,
	onOpened,
	onUnavailable,
	prefill,
	reference,
	showReference = true,
}: {
	/** Who the call is with. Goes with `links`: each event type has its own
	 * people, and the line above the calendar names them. */
	host?: BookingHostInfo | null;
	/** Which event type the calendar books. The configurator's own "discuss
	 * your needs" by default; the portal passes the event intake call. */
	links?: BookingLinkSet;
	onBooked: (booking: BookingSignal) => void;
	/** Which route the person actually got. */
	onOpened: (route: "embed" | "fallback_link") => void;
	onUnavailable: (reason: "timeout" | "blocked", secondsWaited: number) => void;
	/** The reference and the plain summary, in cal.com's own prefill keys. */
	prefill: Record<string, string>;
	reference: string;
	/** The portal hides the code: a participant has nobody to quote it to. */
	showReference?: boolean;
}) => {
	const fallbackHref = useMemo(
		() => bookingLinkWithPrefill(links.BOOK_A_CALL, prefill),
		[links, prefill],
	);

	const { isUnavailable } = useCalEmbed({
		calLink: links.CAL_LINK,
		elementId: EMBED_ELEMENT_ID,
		namespace: links.EMBED_NAMESPACE,
		onBooked,
		onOpened,
		onUnavailable,
		prefill,
	});

	if (isUnavailable) {
		// The screen is true rather than reassuring: the row is written before
		// this step renders, so the answers really are kept whether or not the
		// person ever books.
		//
		// The button stays, and it is the whole point of the screen: without it a
		// person who wants a call has no way to book one, because the embed is
		// exactly what did not load. The plain link carries the same answers on
		// its query string.
		//
		// This screen carries its own thank you line rather than a heading, so
		// the modal drops the step title while it is up. Naming a host above a
		// calendar that did not load would be a second untrue thing on the
		// screen.
		return (
			<Stack gap="lg" {...testId("pricing-configurator-booking-fallback")}>
				<Text>
					<Trans>
						Thank you! We will get in touch as soon as possible. You can also
						write to us at info@dembrane.com.
					</Trans>
				</Text>
				{showReference && (
					<Text fw={500} {...testId("pricing-configurator-booking-reference")}>
						<Trans>Reference {reference}</Trans>
					</Text>
				)}
				<Box>
					<Button
						component="a"
						href={fallbackHref}
						rel="noreferrer"
						size="md"
						target="_blank"
						{...testId("pricing-configurator-booking-link")}
					>
						<Trans>Pick a time</Trans>
					</Button>
				</Box>
			</Stack>
		);
	}

	// The doubled "Pick a time. Please pick a time..." is gone. The modal title
	// says who the call is with, and this says what they will do with the
	// answers before it.
	const host = bookingHostName(hostInfo);

	return (
		<Stack gap="lg" {...testId("pricing-configurator-booking")}>
			<Text size="sm">
				<Trans>
					{host} will read your answers before the call and brings a draft
					offer.
				</Trans>
			</Text>
			<Box id={EMBED_ELEMENT_ID} mih={480} />
			{showReference && (
				<Text size="xs">
					<Trans>Reference {reference}</Trans>
				</Text>
			)}
		</Stack>
	);
};
