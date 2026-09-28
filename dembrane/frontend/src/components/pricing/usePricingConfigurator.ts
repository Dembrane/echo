import { useDisclosure } from "@mantine/hooks";

/** The opener the gates use.
 *
 * Mounting the modal is the caller's job, so this only hands back the open
 * and close a gate needs. `FeatureGate` is untouched.
 *
 *   const configurator = usePricingConfigurator();
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
 */
export const usePricingConfigurator = () => {
	const [opened, handlers] = useDisclosure(false);
	return {
		close: handlers.close,
		/** Spread straight onto `PricingConfigurator`. */
		configuratorProps: { onClose: handlers.close, opened },
		open: handlers.open,
		opened,
	};
};
