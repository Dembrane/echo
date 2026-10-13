import { ErrorPageContent } from "@/components/error/ErrorPageContent";

/**
 * The portal's error page. Participants don't log in, so unlike the dashboard's
 * ErrorPage there is no session check and no sidebar shell (which would also
 * pull the dashboard's sidebar into the portal's first load).
 */
export const ParticipantErrorPage = () => (
	<div className="h-dvh w-screen overflow-auto">
		<ErrorPageContent />
	</div>
);
