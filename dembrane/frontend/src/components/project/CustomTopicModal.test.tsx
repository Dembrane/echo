// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { VerificationTopicMetadata } from "@/lib/api";
import { CustomTopicModal } from "./CustomTopicModal";

// A host's own Verify topic: created blank, edited from what it holds, and
// each opening starts from the topic again.
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
afterEach(cleanup);

const topic = {
	icon: "🌱",
	key: "growth",
	prompt: "What grew?",
	translations: {
		"en-US": { label: "Growth" },
		"nl-NL": { label: "Groei" },
	},
} as unknown as VerificationTopicMetadata;

const tree = (props: {
	opened: boolean;
	mode: "create" | "edit";
	topic?: VerificationTopicMetadata | null;
	onSubmit?: () => void;
}) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<CustomTopicModal
				onClose={() => {}}
				onSubmit={props.onSubmit ?? (() => {})}
				{...props}
			/>
		</MantineProvider>
	</I18nProvider>
);
const value = (id: string) =>
	(screen.getByTestId(id) as HTMLInputElement | HTMLTextAreaElement).value;
const type = (id: string, text: string) =>
	fireEvent.change(screen.getByTestId(id), { target: { value: text } });

it("opens an edit with what the topic holds, and submits only once something changed", () => {
	const onSubmit = vi.fn();
	render(tree({ mode: "edit", onSubmit, opened: true, topic }));
	expect(value("custom-topic-label-en-US")).toBe("Growth");
	expect(value("custom-topic-prompt")).toBe("What grew?");
	expect(value("custom-topic-icon")).toBe("🌱");
	expect(screen.getByTestId("custom-topic-submit")).toHaveProperty(
		"disabled",
		true,
	);

	type("custom-topic-prompt", "What grew, and why?");
	fireEvent.click(screen.getByTestId("custom-topic-submit"));
	expect(onSubmit).toHaveBeenCalledWith(
		expect.objectContaining({ label: "Growth", prompt: "What grew, and why?" }),
	);
});

it("opens a create blank", () => {
	render(tree({ mode: "create", opened: true }));
	expect(value("custom-topic-label-en-US")).toBe("");
	expect(value("custom-topic-prompt")).toBe("");
});

it("starts from the topic again on each opening, dropping unsaved edits", () => {
	const view = render(tree({ mode: "edit", opened: true, topic }));
	type("custom-topic-prompt", "Unsaved");
	view.rerender(tree({ mode: "edit", opened: false, topic }));
	view.rerender(tree({ mode: "edit", opened: true, topic }));
	expect(value("custom-topic-prompt")).toBe("What grew?");
});

it("takes up another topic while open", () => {
	const view = render(tree({ mode: "edit", opened: true, topic }));
	view.rerender(
		tree({
			mode: "edit",
			opened: true,
			topic: { ...topic, prompt: "What changed?" } as VerificationTopicMetadata,
		}),
	);
	expect(value("custom-topic-prompt")).toBe("What changed?");
});
