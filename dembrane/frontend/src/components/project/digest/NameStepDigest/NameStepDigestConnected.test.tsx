// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { DIGEST_RESULT_EN } from "../digest.fixture";
import { NameStepDigestConnected } from "./NameStepDigestConnected";

vi.mock("@/lib/analytics/events", () => ({ track: () => {} }));
vi.mock("@/config", () => ({ API_BASE_URL: "/api" }));
beforeAll(setUpDom);
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("adds the condensed context to what the host wrote and proposes key terms", async () => {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify(DIGEST_RESULT_EN)),
	);
	vi.stubGlobal("fetch", fetch);
	const onContextChange = vi.fn();
	const onKeyTermsChange = vi.fn();
	const { container } = render(
		<Providers>
			<NameStepDigestConnected
				workspaceId="w1"
				language="en"
				name="Evening"
				context="Our evening."
				keyTerms="Thuisbasis"
				onContextChange={onContextChange}
				onKeyTermsChange={onKeyTermsChange}
			/>
		</Providers>,
	);
	const input = (await waitFor(() => {
		const el = container.querySelector("input[type=file]");
		if (!el) throw new Error("not yet");
		return el;
	})) as HTMLInputElement;
	fireEvent.change(input, {
		target: { files: [new File(["Agenda"], "a.txt", { type: "text/plain" })] },
	});
	await screen.findByTestId("project-digest-name-step-added");
	expect(onContextChange).toHaveBeenCalledWith(
		`Our evening.\n\n${DIGEST_RESULT_EN.context}`,
	);
	const body = JSON.parse(
		String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
	);
	expect(body.existing).toEqual({
		context: "Our evening.",
		key_terms: ["Thuisbasis"],
		name: "Evening",
	});
	fireEvent.click(screen.getByText("Sluisweg"));
	expect(onKeyTermsChange).toHaveBeenCalledWith("Thuisbasis, Sluisweg");
});
