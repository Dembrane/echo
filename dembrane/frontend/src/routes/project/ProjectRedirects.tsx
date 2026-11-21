import { Navigate, useLocation } from "react-router";
import { KEY_TERMS_HASH } from "@/components/project/KeyTermsInput";

/**
 * Sends a retired project settings address to its new home (ECHO-1060), keeping the query
 * and the hash, so a link to a part of the page (#project-context) still lands on it.
 */
export const ProjectSettingsRedirect = ({ to }: { to: string }) => {
	const { hash, search } = useLocation();
	return <Navigate to={`../${to}${search}${hash}`} replace />;
};

/**
 * The one-page portal editor's address. Its key terms link (#key-terms) now opens Brief's
 * key terms; anything else opens the portal editor's first page.
 */
export const PortalEditorRedirect = () => {
	const { hash } = useLocation();
	if (hash === `#${KEY_TERMS_HASH}`)
		return <Navigate to={`../brief#${KEY_TERMS_HASH}`} replace />;
	return <Navigate to="../portal/welcome" replace />;
};
