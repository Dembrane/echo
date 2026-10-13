import { ErrorPageContent } from "@/components/error/ErrorPageContent";
import { DEMBRANE_HOME_URL } from "@/config";

/**
 * The portal's error page. Participants don't log in, so unlike the dashboard's
 * ErrorPage there is no session check and no sidebar shell (which would also
 * pull the dashboard's sidebar into the portal's first load). The portal has
 * no home of its own, so "Return home" goes to dembrane.com.
 */
export const ParticipantErrorPage = () => (
	<div className="h-dvh w-screen overflow-auto">
		<ErrorPageContent homeHref={DEMBRANE_HOME_URL} />
	</div>
);
