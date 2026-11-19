// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ReportEditor } from "./ReportEditor";

// The report saves itself a moment after an edit, and an update to the
// report from outside does not overwrite what the host is writing.
const mutateAsync = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./hooks", () => ({
	useUpdateProjectReportMutation: () => ({ mutateAsync }),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("../form/MarkdownWYSIWYG/MarkdownWYSIWYG", () => ({
	MarkdownWYSIWYG: ({
		markdown,
		onChange,
	}: {
		markdown: string;
		onChange: (value: string) => void;
	}) => (
		<textarea
			aria-label="report"
			value={markdown}
			onChange={(e) => onChange(e.target.value)}
		/>
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
afterEach(() => {
	cleanup();
	mutateAsync.mockClear();
});

const report = (content: string) =>
	({
		content,
		date_updated: "2026-11-01T10:00:00.000Z",
		id: 7,
		project_id: "p1",
		show_portal_link: true,
	}) as unknown as ProjectReport;

const tree = (r: ProjectReport) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<ReportEditor report={r} />
		</MantineProvider>
	</I18nProvider>
);
const editor = () => screen.getByLabelText("report") as HTMLTextAreaElement;

it("saves an edit a moment after it is made", async () => {
	render(tree(report("Draft")));
	fireEvent.change(editor(), { target: { value: "Draft, revised" } });
	expect(mutateAsync).not.toHaveBeenCalled();
	await waitFor(
		() =>
			expect(mutateAsync).toHaveBeenCalledWith({
				payload: { content: "Draft, revised", show_portal_link: true },
				projectId: "p1",
				reportId: 7,
			}),
		{ timeout: 3000 },
	);
	expect(mutateAsync).toHaveBeenCalledTimes(1);
});

it("keeps the host's text when the same report arrives again", () => {
	const view = render(tree(report("Draft")));
	fireEvent.change(editor(), { target: { value: "Draft, revised" } });
	view.rerender(tree(report("Draft from the server")));
	expect(editor().value).toBe("Draft, revised");
});
