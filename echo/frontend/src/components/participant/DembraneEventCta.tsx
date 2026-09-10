import { Trans } from "@lingui/react/macro";
import {
	Button,
	List,
	Paper,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import { IconArrowRight, IconCheck } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useCallback } from "react";
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
 * makes the case in three lines and one button. The button opens the same
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
		<Paper
			withBorder
			radius="md"
			p={{ base: "lg", md: "xl" }}
			className="mt-16 md:mt-24"
			{...testId("portal-finish-event-cta")}
		>
			<Stack gap="lg">
				<Stack gap="xs">
					<Title order={3}>
						<Trans>Want to run an event with dembrane?</Trans>
					</Title>
					<Text c="dimmed">
						<Trans>
							We bring the tool and the crew, from the intake call to the
							report. Proven across 1000+ events.
						</Trans>
					</Text>
				</Stack>
				<List
					spacing="sm"
					// Three lines wrap on a phone; the tick belongs on the first one.
					styles={{
						itemIcon: { marginTop: 2 },
						itemWrapper: { alignItems: "flex-start" },
					}}
					icon={
						<ThemeIcon size={22} radius="xl" variant="light">
							<IconCheck size={14} strokeWidth={3} />
						</ThemeIcon>
					}
					{...testId("portal-finish-event-cta-reasons")}
				>
					<List.Item>
						<Trans>
							No app, no hardware. Participants scan a QR code and their phones
							become the portal.
						</Trans>
					</List.Item>
					<List.Item>
						<Trans>
							Results before people leave. We run the analysis live and present
							it in the room.
						</Trans>
					</List.Item>
					<List.Item>
						<Trans>
							Every insight traceable. The report links each finding back to
							what was actually said.
						</Trans>
					</List.Item>
				</List>
				<Button
					size="xl"
					fullWidth
					rightSection={<IconArrowRight size={20} />}
					onClick={handleOpen}
					{...testId("portal-finish-event-cta-button")}
				>
					<Trans>Get in touch</Trans>
				</Button>
			</Stack>
			<PricingConfigurator
				{...configurator.configuratorProps}
				entry="modal_direct"
				locale={language}
				mount="portal"
				onEvent={onEvent}
				projectId={projectId}
				submit={submitPortalConfiguration}
			/>
		</Paper>
	);
};
