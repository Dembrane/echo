import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { BOOKING_REFERENCE_METADATA_KEY } from "@/components/pricing/bookingPrefill";
import {
	type BookingSignal,
	bookingHostName,
	PricingBookingStep,
} from "@/components/pricing/PricingBookingStep";
import { useV2Me } from "@/hooks/useV2Me";
import { call } from "../api/client";
import { accountKeys } from "../api/hooks";

/**
 * The needs form's cal.com step, reused with its own intro line. The booking is recorded on the account so
 * staff see it on the card; the reference ties it to the needs form the account came from.
 */
export default function BookCall({
	orgId,
	reference,
}: {
	orgId: string;
	reference: string;
}) {
	const { data: me } = useV2Me();
	const queryClient = useQueryClient();
	const prefill = useMemo(() => {
		const p: Record<string, string> = { notes: `Reference ${reference}` };
		p[BOOKING_REFERENCE_METADATA_KEY] = reference;
		if (me?.display_name) p.name = me.display_name;
		if (me?.email) p.email = me.email;
		return p;
	}, [me?.display_name, me?.email, reference]);

	const onBooked = useCallback(
		(booking: BookingSignal) => {
			if (!booking.uid) return;
			void call("recordBooking", {
				body: {
					start: booking.startTime,
					status: booking.status,
					uid: booking.uid,
				},
				params: { orgId },
			})
				// The booking completes "Book a call with us": show the step done.
				.then(() =>
					queryClient.invalidateQueries({ queryKey: accountKeys.all }),
				)
				.catch(() => {});
		},
		[orgId, queryClient],
	);
	const noop = useCallback(() => {}, []);
	const host = bookingHostName();

	return (
		<PricingBookingStep
			intro={
				<Trans>Pick a time. {host} reads your account before the call.</Trans>
			}
			reference={reference}
			prefill={prefill}
			onBooked={onBooked}
			onOpened={noop}
			onUnavailable={noop}
		/>
	);
}
