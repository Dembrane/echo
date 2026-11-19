// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ReportRenderer } from "./ReportRenderer";

// Moving to another report that is already cached shows that report in the
// editor, not the text of the one before.
const reports: Record<number, ProjectReport> = {
	1: { content: "First report", id: 1, project_id: "p1" } as ProjectReport,
	2: { content: "Second report", id: 2, project_id: "p1" } as ProjectReport,
};
vi.mock("./hooks", () => ({
	useProjectReport: (_: string, id: number) => ({
		data: reports[id],
		isLoading: false,
	}),
	usePublicProjectReport: () => ({ data: undefined, isLoading: false }),
	useUpdateProjectReportMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("../form/MarkdownWYSIWYG/MarkdownWYSIWYG", () => ({
	MarkdownWYSIWYG: ({ markdown }: { markdown: string }) => (
		<textarea aria-label="report" value={markdown} readOnly />
	),
}));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const tree = (reportId: number) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<ReportRenderer projectId="p1" reportId={reportId} isEditing />
		</MantineProvider>
	</I18nProvider>
);
const editor = () => screen.getByLabelText("report") as HTMLTextAreaElement;

it("edits the report it was moved to", () => {
	const view = render(tree(1));
	expect(editor().value).toBe("First report");
	view.rerender(tree(2));
	expect(editor().value).toBe("Second report");
});
