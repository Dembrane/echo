import { useDisclosure } from "@mantine/hooks";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { readStoredOpener, writeStoredOpener } from "./configuratorState";
import { STEP_PARAM } from "./PricingConfigurator";

/** The opener the gates use.
 *
 * Mounting the modal is the caller's job, so this only hands back the open
 * and close a gate needs. `FeatureGate` is untouched.
 *
 *   const configurator = usePricingConfigurator("transcription_cap");
 *   <button onClick={configurator.open}>Tell us what you need</button>
 *   <PricingConfigurator
 *     {...configurator.configuratorProps}
 *     wallKey="transcription_cap"
 *     variant="transcription_cap"
 *     entry="popover_link"
 *     onEvent={emitPricingEvent}
 *   />
 *
 * `pricing_config_gate_viewed` is not fired here. The gate is the popover on
 * the blocked control, which this hook never sees, and the event carries
 * `surface`, `required_tier` and `can_request_upgrade`, none of which the
 * configurator knows.
 *
 * `opener` names this caller: a reload mid-form reopens the modal for the
 * opener that had it up, since the step stays in the URL.
 */
export const usePricingConfigurator = (opener: string) => {
	const [searchParams] = useSearchParams();
	const [opened, handlers] = useDisclosure(
		searchParams.has(STEP_PARAM) && readStoredOpener() === opener,
	);
	const open = useCallback(() => {
		writeStoredOpener(opener);
		handlers.open();
	}, [handlers, opener]);
	const close = useCallback(() => {
		writeStoredOpener(null);
		handlers.close();
	}, [handlers]);
	return {
		close,
		/** Spread straight onto `PricingConfigurator`. */
		configuratorProps: { onClose: close, opened },
		open,
		opened,
	};
};
