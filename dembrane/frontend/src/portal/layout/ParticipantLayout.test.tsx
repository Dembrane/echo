// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
	useWhitelabelLogo,
	WhitelabelLogoProvider,
} from "@/hooks/useWhitelabelLogo";
import { ParticipantLayout } from "./ParticipantLayout";

const project = vi.hoisted(() => ({
	current: undefined as { whitelabel_logo_url?: string | null } | undefined,
}));
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({ data: project.current }),
}));
vi.mock("../laterScreens", () => ({ prefetchLaterScreens: () => {} }));
vi.mock("./ParticipantHeader", () => ({ ParticipantHeader: () => null }));
vi.mock("../../components/common/Toaster", () => ({ Toaster: () => null }));
vi.mock("../../components/layout/I18nProvider", () => ({
	I18nProvider: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
	cleanup();
	project.current = undefined;
});

// what a Logo inside the portal sees
const LogoProbe = () => {
	const { logoUrl } = useWhitelabelLogo();
	return <div data-testid="logo">{String(logoUrl)}</div>;
};

// what a Logo outside the portal, elsewhere in the app, sees
const OutsideProbe = () => {
	const { logoUrl } = useWhitelabelLogo();
	return <div data-testid="outside">{String(logoUrl)}</div>;
};

const renderAt = (path: string) =>
	render(
		<WhitelabelLogoProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/:projectId" element={<ParticipantLayout />}>
						<Route path="start" element={<LogoProbe />} />
						<Route path="report" element={<LogoProbe />} />
					</Route>
				</Routes>
			</MemoryRouter>
			<OutsideProbe />
		</WhitelabelLogoProvider>,
	);

it("shows the project's whitelabel logo inside the portal", () => {
	project.current = { whitelabel_logo_url: "https://example.com/logo.png" };
	renderAt("/p1/start");
	expect(screen.getByTestId("logo").textContent).toBe(
		"https://example.com/logo.png",
	);
});

it("shows it on the report page too, which has no header", () => {
	project.current = { whitelabel_logo_url: "https://example.com/logo.png" };
	renderAt("/p1/report");
	expect(screen.getByTestId("logo").textContent).toBe(
		"https://example.com/logo.png",
	);
});

it("falls back to the default logo when the project has none", () => {
	project.current = { whitelabel_logo_url: null };
	renderAt("/p1/start");
	expect(screen.getByTestId("logo").textContent).toBe("null");
});

it("leaves the rest of the app's logo alone", () => {
	project.current = { whitelabel_logo_url: "https://example.com/logo.png" };
	renderAt("/p1/start");
	expect(screen.getByTestId("outside").textContent).toBe("undefined");
});
