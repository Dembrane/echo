import { Trans } from "@lingui/react/macro";
import { Box, Button } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useCallback } from "react";
import PaulineUnderstandArt from "@/assets/pauline-understand.webp";
import {
	PricingConfigurator,
	submitPortalConfiguration,
	usePricingConfigurator,
} from "@/components/pricing";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";

/** The last card on the thank you page: run your own event with dembrane.
 *
 * A participant has just spent ten minutes talking into their phone at
 * somebody else's event. This is the one moment they are a lead, so the card
 * uses one illustration and one button. The button opens the same
 * intake form the pricing configurator and the website's needs form use: an
 * email, six questions, then the event intake calendar, inside the portal
 * rather than on another site. The answers land on a `pricing_configuration`
 * row with a PTL- reference and the project the participant was in.
 *
 * Hosts on a paid plan can switch the card off per project
 * (`is_dembrane_event_cta_enabled`); the free tier always shows it. That
 * decision is the server's: the portal only reads the resolved flag.
 */
export const DembraneEventCta = ({ projectId }: { projectId: string }) => {
	const { language } = useLanguage();
	const configurator = usePricingConfigurator();

	// The configurator's events, on the portal's own PostHog. `surface` tells
	// the funnels apart from the dashboard's gates without a workspace.
	const onEvent = useCallback(
		(name: string, props: Record<string, unknown>) => {
			posthog.capture(name, {
				...props,
				project_id: projectId,
				surface: "participant_portal",
			});
		},
		[projectId],
	);

	const handleOpen = () => {
		posthog.capture("portal_event_cta_clicked", { project_id: projectId });
		configurator.open();
	};

	return (
		<>
			<img
				src={PaulineUnderstandArt}
				alt=""
				className="mx-auto mt-2 h-auto w-full max-w-lg px-4"
				{...testId("portal-finish-event-cta-art")}
			/>
			{/* The one ask on the page stays in reach however far they scroll. It
			    is the last thing in the flow, so `sticky` pins it to the bottom
			    of the viewport until the page runs out and it settles in place. */}
			<Box
				bg="var(--app-background)"
				className="sticky bottom-0 z-10 mt-auto flex justify-center border-t border-slate-300 p-4 pt-6"
				{...testId("portal-finish-event-cta")}
			>
				<Button
					// Secondary: the page's job is done and this is an offer, not a
					// call to action, but it is the one thing left to do here.
					variant="outline"
					size="lg"
					className="w-full sm:w-auto sm:min-w-80"
					rightSection={<IconArrowRight size={18} />}
					onClick={handleOpen}
					{...testId("portal-finish-event-cta-button")}
				>
					<Trans>dembrane at your event?</Trans>
				</Button>
			</Box>
			<PricingConfigurator
				{...configurator.configuratorProps}
				entry="modal_direct"
				locale={language}
				mount="portal"
				onEvent={onEvent}
				projectId={projectId}
				submit={submitPortalConfiguration}
			/>
		</>
	);
};
