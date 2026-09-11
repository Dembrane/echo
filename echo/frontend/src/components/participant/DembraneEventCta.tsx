import { Trans } from "@lingui/react/macro";
import { Box, Button } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import posthog from "posthog-js";
import PaulineUnderstandArt from "@/assets/pauline-understand.webp";
import { useLanguage } from "@/hooks/useLanguage";
import { eventEnquiryUrl } from "@/lib/links";
import { testId } from "@/lib/testUtils";

/** The last card on the thank you page: run your own event with dembrane.
 *
 * A participant has just spent ten minutes talking into their phone at
 * somebody else's event. This is the one moment they are a lead, so the card
 * uses one illustration and one button. The button opens the website's needs
 * form in a new tab, with the project the participant was in on the URL. The
 * site writes that onto the row as `project_id`, so the enquiry is a website
 * enquiry like any other (a WEB- reference, `mount: site`, the daily digest
 * and the booking notice) and still reads as "was at this event". One write
 * path for every lead; nothing downstream has to know about the portal.
 *
 * Hosts on a paid plan can switch the card off per project
 * (`is_dembrane_event_cta_enabled`); the free tier always shows it. That
 * decision is the server's: the portal only reads the resolved flag.
 */
export const DembraneEventCta = ({ projectId }: { projectId: string }) => {
	const { language } = useLanguage();
	const href = eventEnquiryUrl({ language, projectId });

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
				className="sticky bottom-0 z-10 mt-6 border-t border-slate-300 p-4"
				{...testId("portal-finish-event-cta")}
			>
				<Button
					component="a"
					href={href}
					rel="noopener noreferrer"
					target="_blank"
					// Tertiary on purpose. The page's job is done; this is a quiet
					// offer, not a call to action, and it is already always in view.
					variant="subtle"
					size="lg"
					fullWidth
					rightSection={<IconArrowRight size={18} />}
					onClick={() =>
						posthog.capture("portal_event_cta_clicked", {
							project_id: projectId,
						})
					}
					{...testId("portal-finish-event-cta-button")}
				>
					<Trans>dembrane at your event?</Trans>
				</Button>
			</Box>
		</>
	);
};
