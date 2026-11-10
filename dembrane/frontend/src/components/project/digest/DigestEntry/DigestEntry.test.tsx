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
import { DigestEntry } from "./DigestEntry";

beforeAll(setUpDom);
afterEach(cleanup);

const renderEntry = () => {
	const onSubmit = vi.fn();
	const view = render(
		<Providers>
			<DigestEntry onSubmit={onSubmit} />
		</Providers>,
	);
	return { ...view, onSubmit };
};

it("says what is sent where, always", () => {
	renderEntry();
	expect(screen.getByTestId("project-digest-privacy").textContent).toContain(
		"Files stay on your device",
	);
	expect(
		screen
			.getByLabelText("Drop files or choose them")
			.getAttribute("aria-describedby"),
	).toBe(screen.getByTestId("project-digest-privacy").id);
});

it("hands over chosen files, a refused type included, so it can say why", async () => {
	const { container, onSubmit } = renderEntry();
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	expect(input.getAttribute("accept")).toContain(".pptx");
	const pdf = new File(["%PDF"], "agenda.pdf", { type: "application/pdf" });
	const doc = new File(["x"], "oud.doc", { type: "application/msword" });
	fireEvent.change(input, { target: { files: [pdf, doc] } });
	await waitFor(() => expect(onSubmit).toHaveBeenCalled());
	expect(onSubmit.mock.calls[0][0].files.map((f: File) => f.name)).toEqual([
		"agenda.pdf",
		"oud.doc",
	]);
});

it("pasted text and a link go in with Set up from this; a bad link does not", () => {
	const { onSubmit } = renderEntry();
	fireEvent.click(screen.getByTestId("project-digest-paste-toggle"));
	fireEvent.click(screen.getByTestId("project-digest-link-toggle"));
	fireEvent.change(screen.getByTestId("project-digest-url"), {
		target: { value: "not a link" },
	});
	expect(
		(screen.getByTestId("project-digest-submit") as HTMLButtonElement).disabled,
	).toBe(true);
	fireEvent.change(screen.getByTestId("project-digest-text"), {
		target: { value: " Agenda " },
	});
	fireEvent.click(screen.getByTestId("project-digest-submit"));
	expect(onSubmit).toHaveBeenCalledWith({ files: [], text: "Agenda", url: "" });
});

it("a link pasted into the zone becomes the link", () => {
	renderEntry();
	fireEvent.paste(screen.getByTestId("project-digest-dropzone"), {
		clipboardData: { files: [], getData: () => "https://example.org/brief" },
	});
	expect(
		(screen.getByTestId("project-digest-url") as HTMLInputElement).value,
	).toBe("https://example.org/brief");
});
