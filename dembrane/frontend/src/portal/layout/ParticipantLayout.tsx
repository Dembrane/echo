import { useEffect } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { WhitelabelLogoScope } from "@/hooks/useWhitelabelLogo";
import { logoUrl } from "@/lib/avatar";
import { useParticipantProjectById } from "@/portal/hooks/useParticipantProjectById";
import { Toaster } from "../../components/common/Toaster";
import { I18nProvider } from "../../components/layout/I18nProvider";
import { prefetchLaterScreens } from "../laterScreens";
import { ParticipantHeader } from "./ParticipantHeader";

export const ParticipantLayout = () => {
	const { pathname } = useLocation();
	const { projectId } = useParams();
	const isReportPage = pathname.includes("report");

	// Resolve the whitelabel logo here, not in ParticipantHeader: the report
	// page renders without the header and Logo spins until the context resolves.
	// Scoped to the portal, so it doesn't stay set once the participant leaves.
	const projectQuery = useParticipantProjectById(projectId ?? "");
	// a file id, or an absolute URL on older workspace rows
	const whitelabelLogo =
		logoUrl(projectQuery.data?.whitelabel_logo_url) ?? null;

	useEffect(() => prefetchLaterScreens(), []);

	if (isReportPage) {
		return (
			<WhitelabelLogoScope logoUrl={whitelabelLogo}>
				<I18nProvider>
					<Toaster />
					<main className="relative min-h-dvh">
						<Outlet />
					</main>
				</I18nProvider>
			</WhitelabelLogoScope>
		);
	}

	return (
		<WhitelabelLogoScope logoUrl={whitelabelLogo}>
			<I18nProvider>
				<Toaster />
				<main className="relative !h-dvh overflow-y-auto">
					<div className="flex h-full flex-col">
						<ParticipantHeader />
						<main className="relative grow">
							<Outlet />
						</main>
					</div>
				</main>
			</I18nProvider>
		</WhitelabelLogoScope>
	);
};
