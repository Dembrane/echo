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
	within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { CopyableWebhook, Webhook } from "@/lib/api";
import { WebhookSection } from "./WebhookSettingsCard";

// A project's webhooks: added fresh or cloned from another project, edited,
// switched on and off. Each opening of the form starts again.
const state = vi.hoisted(() => ({
	copyable: [] as CopyableWebhook[],
	create: vi.fn(async (_vars: unknown) => ({})),
	update: vi.fn(async (_vars: unknown) => ({})),
	webhooks: [] as Webhook[],
}));
vi.mock("../hooks", () => ({
	useCopyableWebhooks: () => ({ data: state.copyable, isLoading: false }),
	useCreateWebhookMutation: () => ({
		isPending: false,
		mutateAsync: state.create,
	}),
	useDeleteWebhookMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useProjectWebhooks: () => ({
		data: state.webhooks,
		error: null,
		isLoading: false,
	}),
	useTestWebhookMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useUpdateWebhookMutation: () => ({
		isPending: false,
		mutateAsync: state.update,
	}),
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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
	state.copyable = [];
	state.webhooks = [];
});
afterEach(() => {
	cleanup();
	state.create.mockClear();
	state.update.mockClear();
});

const hook: Webhook = {
	date_created: null,
	date_updated: null,
	events: ["report.generated"],
	id: "w1",
	name: "Slack",
	status: "published",
	url: "https://hooks.example.com/slack",
};

const show = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<WebhookSection projectId="p1" />
			</MantineProvider>
		</I18nProvider>,
	);
const dialog = () => within(screen.getByRole("dialog"));
const field = (label: string) =>
	dialog().getByLabelText(label, { exact: false }) as HTMLInputElement;
const type = (label: string, value: string) =>
	fireEvent.change(field(label), { target: { value } });
const openAdd = () =>
	fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));

it("with nothing to clone, opens a blank form and adds the webhook", async () => {
	show();
	openAdd();
	expect(field("Name").value).toBe("");
	type("Name", "Zapier");
	type("Webhook URL", "https://hooks.zapier.com/1");
	fireEvent.click(dialog().getByRole("button", { name: "Add webhook" }));
	await waitFor(() =>
		expect(state.create).toHaveBeenCalledWith({
			payload: {
				events: [
					"conversation.started",
					"conversation.transcribed",
					"conversation.summarized",
				],
				name: "Zapier",
				url: "https://hooks.zapier.com/1",
			},
			projectId: "p1",
		}),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("clones another project's webhook, all but its secret", async () => {
	state.copyable = [
		{
			events: ["report.generated"],
			id: "c1",
			name: "Make",
			project_id: "p2",
			project_name: "Other project",
			url: "https://hook.make.com/9",
		},
	];
	show();
	openAdd();
	fireEvent.click(dialog().getByText("Clone from another project"));
	fireEvent.click(dialog().getByPlaceholderText("Search webhooks..."));
	fireEvent.click(screen.getByRole("option", { name: "Make" }));
	expect(field("Webhook URL").value).toBe("https://hook.make.com/9");
	type("Secret", "s3cret");
	fireEvent.click(dialog().getByRole("button", { name: "Add webhook" }));
	await waitFor(() =>
		expect(state.create).toHaveBeenCalledWith({
			payload: {
				events: ["report.generated"],
				name: "Make",
				secret: "s3cret",
				url: "https://hook.make.com/9",
			},
			projectId: "p1",
		}),
	);
});

it("starts fresh even with webhooks to clone", () => {
	state.copyable = [
		{
			events: null,
			id: "c1",
			name: "Make",
			project_id: "p2",
			project_name: "Other project",
			url: "https://hook.make.com/9",
		},
	];
	show();
	openAdd();
	fireEvent.click(dialog().getByText("Start fresh"));
	expect(field("Name").value).toBe("");
	expect(field("Webhook URL").value).toBe("");
});

it("edits a webhook from what it holds, keeping the secret when left empty", async () => {
	// Mantine's test env renders portals in place, so the row's delete modal
	// lands inside <tbody> and React warns about the nesting. In the app it is
	// portalled to <body>. Only that warning is let through.
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	state.webhooks = [hook];
	show();
	const row = within(screen.getByText("Slack").closest("tr") as HTMLElement);
	fireEvent.click(row.getAllByRole("button")[1]);
	expect(field("Name").value).toBe("Slack");
	expect(field("Webhook URL").value).toBe("https://hooks.example.com/slack");
	type("Name", "Slack alerts");
	fireEvent.click(dialog().getByRole("button", { name: "Save changes" }));
	await waitFor(() =>
		expect(state.update).toHaveBeenCalledWith({
			payload: {
				events: ["report.generated"],
				name: "Slack alerts",
				url: "https://hooks.example.com/slack",
			},
			projectId: "p1",
			webhookId: "w1",
		}),
	);
	for (const [message] of errors.mock.calls) {
		expect(String(message)).toContain("cannot be a child of");
	}
	errors.mockRestore();
});

it("starts again on each opening, dropping unsaved edits", () => {
	show();
	openAdd();
	type("Name", "Unsaved");
	fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
	openAdd();
	expect(field("Name").value).toBe("");
});

it("asks for a name and a web URL before adding", async () => {
	show();
	openAdd();
	type("Webhook URL", "ftp://nope");
	fireEvent.click(dialog().getByRole("button", { name: "Add webhook" }));
	expect(await dialog().findByText("Name is required")).toBeTruthy();
	expect(
		dialog().getByText("URL must start with http:// or https://"),
	).toBeTruthy();
	expect(state.create).not.toHaveBeenCalled();
});

it("switches a webhook off", async () => {
	state.webhooks = [hook];
	show();
	const toggle = screen.getByRole("switch");
	expect(toggle).toHaveProperty("checked", true);
	fireEvent.click(toggle);
	await waitFor(() =>
		expect(state.update).toHaveBeenCalledWith({
			payload: { status: "draft" },
			projectId: "p1",
			webhookId: "w1",
		}),
	);
});
