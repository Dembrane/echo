import { useEffect } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { DIRECTUS_PUBLIC_URL } from "@/config";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { useParticipantProjectById } from "../participant/hooks";
import { I18nProvider } from "./I18nProvider";
import { ParticipantHeader } from "./ParticipantHeader";

export const ParticipantLayout = () => {
	const { pathname } = useLocation();
	const { projectId } = useParams();
	const isReportPage = pathname.includes("report");

	// Resolve the whitelabel logo here, not in ParticipantHeader: the report
	// page renders without the header and Logo spins until the context resolves.
	const { setLogoUrl } = useWhitelabelLogo();
	const projectQuery = useParticipantProjectById(projectId ?? "");

	useEffect(() => {
		const logoFileId = projectQuery.data?.whitelabel_logo_url;
		if (logoFileId) {
			setLogoUrl(`${DIRECTUS_PUBLIC_URL}/assets/${logoFileId}`);
		} else {
			setLogoUrl(null);
		}
	}, [projectQuery.data, setLogoUrl]);

	if (isReportPage) {
		return (
			<I18nProvider>
				<main className="relative min-h-dvh">
					<Outlet />
				</main>
			</I18nProvider>
		);
	}

	return (
		<I18nProvider>
			<main className="relative !h-dvh overflow-y-auto">
				<div className="flex h-full flex-col">
					<ParticipantHeader />
					<main className="relative grow">
						<Outlet />
					</main>
				</div>
			</main>
		</I18nProvider>
	);
};
