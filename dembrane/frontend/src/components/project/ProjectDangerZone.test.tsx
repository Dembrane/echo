// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectDangerZone } from "./ProjectDangerZone";

const navigateMock = vi.hoisted(() => vi.fn());
const deleteMutate = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "owner" }));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigateMock,
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
	}),
}));
vi.mock("./hooks", () => ({
	useCloneProjectByIdMutation: () => ({
		error: null,
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useDeleteProjectByIdMutation: () => ({
		isPending: false,
		mutate: deleteMutate,
	}),
}));
// Two-step confirm collapsed to a plain button per modal.
vi.mock("@/components/common/ConfirmModal", () => ({
	ConfirmModal: (props: {
		opened: boolean;
		onConfirm: () => void;
		"data-testid"?: string;
	}) =>
		props.opened ? (
			<button
				type="button"
				data-testid={`${props["data-testid"]}-confirm`}
				onClick={props.onConfirm}
			>
				confirm
			</button>
		) : null,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	deleteMutate.mockReset();
	role.current = "owner";
});

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

const project = { id: "p1", language: "en", name: "Alpha" } as Project;

const renderZone = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/w/w1/projects/p1/overview"]}>
					<Routes>
						<Route
							path="/w/:workspaceId/projects/:projectId/overview"
							element={<ProjectDangerZone project={project} />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const confirmDelete = () => {
	fireEvent.click(screen.getByTestId("project-actions-delete-button"));
	fireEvent.click(screen.getByTestId("project-delete-modal-confirm"));
	fireEvent.click(screen.getByTestId("project-delete-final-modal-confirm"));
};

describe("ProjectDangerZone delete", () => {
	it("stays on the project when the delete is refused", () => {
		deleteMutate.mockImplementation(
			(_id: string, opts?: { onError?: (e: Error) => void }) =>
				opts?.onError?.(new Error("403")),
		);
		renderZone();
		confirmDelete();
		expect(navigateMock).not.toHaveBeenCalled();
		expect(deleteMutate).toHaveBeenCalledWith("p1", expect.anything());
	});

	it("navigates home once the delete succeeds", () => {
		deleteMutate.mockImplementation(
			(_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
		);
		renderZone();
		confirmDelete();
		expect(navigateMock).toHaveBeenCalledWith("/w/w1/home");
	});
});

describe("ProjectDangerZone role gating", () => {
	it.each([
		// project:create gates clone, project:delete gates delete
		["owner", true, true],
		["admin", true, true],
		["member", true, false],
		["external", false, false],
		["observer", false, false],
	])("%s: clone %s, delete %s", (r, canClone, canDelete) => {
		role.current = r;
		renderZone();
		expect(!!screen.queryByTestId("project-actions-clone-button")).toBe(
			canClone,
		);
		expect(!!screen.queryByTestId("project-actions-delete-button")).toBe(
			canDelete,
		);
	});
});
