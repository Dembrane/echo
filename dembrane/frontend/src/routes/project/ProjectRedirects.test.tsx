// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
	PortalEditorRedirect,
	ProjectSettingsRedirect,
} from "./ProjectRedirects";

afterEach(cleanup);

const Landed = () => {
	const { pathname, search, hash } = useLocation();
	return <div data-testid="landed">{`${pathname}${search}${hash}`}</div>;
};

const land = (from: string) => {
	render(
		<MemoryRouter initialEntries={[from]}>
			<Routes>
				<Route path="/w/:workspaceId/projects/:projectId">
					<Route
						path="overview"
						element={<ProjectSettingsRedirect to="brief" />}
					/>
					<Route
						path="integrations"
						element={<ProjectSettingsRedirect to="advanced" />}
					/>
					<Route path="portal-editor" element={<PortalEditorRedirect />} />
					<Route path="*" element={<Landed />} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
	const text = screen.getByTestId("landed").textContent;
	cleanup();
	return text;
};

// ECHO-1060: the retired settings addresses land on the settings' new homes.
describe("project settings redirects", () => {
	it("General goes to Brief, keeping the part of the page a link pointed at", () => {
		expect(land("/w/w1/projects/p1/overview")).toBe("/w/w1/projects/p1/brief");
		expect(land("/w/w1/projects/p1/overview?x=1#project-context")).toBe(
			"/w/w1/projects/p1/brief?x=1#project-context",
		);
	});

	it("the portal editor's key terms link goes to Brief's key terms", () => {
		expect(land("/w/w1/projects/p1/portal-editor#key-terms")).toBe(
			"/w/w1/projects/p1/brief#key-terms",
		);
		expect(land("/w/w1/projects/p1/portal-editor")).toBe(
			"/w/w1/projects/p1/portal/welcome",
		);
	});

	it("Automation goes to Manage, Advanced", () => {
		expect(land("/w/w1/projects/p1/integrations")).toBe(
			"/w/w1/projects/p1/advanced",
		);
	});
});
