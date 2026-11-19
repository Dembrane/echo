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
import { EmailCustomerModal, type EmailSubject } from "./EmailCustomerModal";

// The manager emails the customer: a dry run draws the preview, the real one sends.
type Body = { dry_run: boolean; note: string | null; task_id?: string };
const sent: Body[] = [];
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("../api/hooks", () => ({
	useAccountsMutation: () => ({
		isPending: false,
		mutate: (
			{ body }: { body: Body },
			{ onSuccess }: { onSuccess: (r: unknown) => void },
		) => {
			sent.push(body);
			onSuccess(
				body.dry_run
					? {
							messages: [
								{
									subject: `About ${body.task_id}`,
									text: body.note ?? "no note",
									to: "robin@example-town.example",
								},
							],
						}
					: { queued: 1 },
			);
		},
	}),
}));
vi.mock("@/components/common/Toaster", () => ({
	toast: { success: toastSuccess },
}));
vi.mock("@/components/error/notifyError", () => ({ notifyError: vi.fn() }));

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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	sent.length = 0;
	toastSuccess.mockReset();
});

const reminder = (task_id: string): EmailSubject => ({
	kind: "task_reminder",
	label: `Reminder for ${task_id}`,
	task_id,
});
const tree = (subject: EmailSubject | null, onClose = () => {}) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<EmailCustomerModal subject={subject} onClose={onClose} orgId="org" />
		</MantineProvider>
	</I18nProvider>
);
const preview = () => screen.queryByTestId("email-preview")?.textContent;

it("draws the email it will send when it opens", async () => {
	render(tree(reminder("t-1")));
	await waitFor(() => expect(preview()).toContain("About t-1"));
	expect(screen.getByText("To: robin@example-town.example")).toBeTruthy();
	expect(sent[0]).toMatchObject({ dry_run: true, note: null });
});

it("draws it again with the manager's own line once they stop typing", async () => {
	render(tree(reminder("t-1")));
	await waitFor(() => expect(preview()).toContain("no note"));
	fireEvent.change(screen.getByLabelText("Your own line (optional)"), {
		target: { value: "See you Tuesday" },
	});
	await waitFor(() => expect(preview()).toContain("See you Tuesday"));
});

it("never shows one subject's email under another", async () => {
	const view = render(tree(reminder("t-1")));
	await waitFor(() => expect(preview()).toContain("About t-1"));
	view.rerender(tree(null));
	view.rerender(tree(reminder("t-2")));
	expect(preview() ?? "").not.toContain("About t-1");
	await waitFor(() => expect(preview()).toContain("About t-2"));
});

it("sends for real, says so, and closes", async () => {
	const onClose = vi.fn();
	render(tree(reminder("t-1"), onClose));
	await waitFor(() => expect(preview()).toContain("About t-1"));
	fireEvent.click(screen.getByTestId("email-send"));
	expect(sent.at(-1)).toMatchObject({ dry_run: false, task_id: "t-1" });
	expect(toastSuccess).toHaveBeenCalledWith("Email sent");
	expect(onClose).toHaveBeenCalled();
});
