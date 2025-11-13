import { Outlet, useLocation } from "react-router";
import { I18nProvider } from "./I18nProvider";
import { ParticipantHeader } from "./ParticipantHeader";

export const ParticipantLayout = () => {
	const { pathname } = useLocation();
	const isReportPage = pathname.includes("report");

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
