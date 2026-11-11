import { useParams } from "react-router";
import { ErrorPageContent } from "@/components/error/ErrorPageContent";
import { ADMIN_BASE_URL } from "@/config";

/**
 * The portal's error page. Participants don't log in, so unlike the dashboard's
 * ErrorPage there is no session check and no sidebar shell (which would also
 * pull the dashboard's sidebar into the portal's first load). "Return home"
 * goes to the project's start page, or to the dashboard when the URL names no
 * project (ECHO-984).
 */
export const ParticipantErrorPage = () => {
	const { language, projectId } = useParams();
	const homeHref = projectId
		? `/${language ? `${language}/` : ""}${projectId}/start`
		: ADMIN_BASE_URL;
	return (
		<div className="h-dvh w-screen overflow-auto">
			<ErrorPageContent homeHref={homeHref} />
		</div>
	);
};
