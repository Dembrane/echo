import { Trans } from "@lingui/react/macro";
import { Button, Stack } from "@mantine/core";
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
		<Stack
			gap="lg"
			className="mt-16 md:mt-24"
			{...testId("portal-finish-event-cta")}
		>
			<img
				src={PaulineUnderstandArt}
				alt=""
				className="mx-auto h-auto w-full max-w-lg"
				{...testId("portal-finish-event-cta-art")}
			/>
			<Button
				size="xl"
				fullWidth
				// The question is the label, and in Dutch or German it runs to two
				// lines on a phone. A button that clips its own question is worse
				// than a taller one.
				h="auto"
				py="md"
				styles={{ label: { lineHeight: 1.25, whiteSpace: "normal" } }}
				rightSection={<IconArrowRight size={20} />}
				onClick={handleOpen}
				{...testId("portal-finish-event-cta-button")}
			>
				<Trans>Want to use dembrane at your next event?</Trans>
			</Button>
			<PricingConfigurator
				{...configurator.configuratorProps}
				entry="modal_direct"
				locale={language}
				mount="portal"
				onEvent={onEvent}
				projectId={projectId}
				submit={submitPortalConfiguration}
			/>
		</Stack>
	);
};
