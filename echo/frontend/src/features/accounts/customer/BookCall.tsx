import { useCallback, useMemo } from "react";
import { BOOKING_REFERENCE_METADATA_KEY } from "@/components/pricing/bookingPrefill";
import {
	type BookingSignal,
	PricingBookingStep,
} from "@/components/pricing/PricingBookingStep";
import { useV2Me } from "@/hooks/useV2Me";
import { call } from "../api/client";

/**
 * The needs form's cal.com step, reused as is. The booking is recorded on the account so
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
			}).catch(() => {});
		},
		[orgId],
	);
	const noop = useCallback(() => {}, []);

	return (
		<PricingBookingStep
			reference={reference}
			prefill={prefill}
			onBooked={onBooked}
			onOpened={noop}
			onUnavailable={noop}
		/>
	);
}
