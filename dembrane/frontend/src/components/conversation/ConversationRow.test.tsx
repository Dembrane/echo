// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationRow } from "./ProjectConversationsPanel";

i18n.load("en-US", {});
i18n.activate("en-US");

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
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

afterEach(cleanup);

const conversation = {
	id: "c1",
	participant_name: "Sofia",
	tags: [],
} as unknown as Parameters<typeof ConversationRow>[0]["conversation"];

const renderRow = (canManage: boolean) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<ConversationRow
							conversation={conversation}
							canManage={canManage}
							onEdit={vi.fn()}
							onOpen={vi.fn()}
						/>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("ConversationRow", () => {
	it("offers Manage to roles that can edit conversations", () => {
		renderRow(true);
		expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
	});

	it("hides Manage from read-only roles, whose saves the API refuses", () => {
		renderRow(false);
		expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Open conversation" }),
		).toBeTruthy();
	});
});
