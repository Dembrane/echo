// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { DigestProgress } from "./DigestProgress";

beforeAll(setUpDom);
afterEach(cleanup);

it("shows each file's state, why one was refused, and cancels", () => {
	const onCancel = vi.fn();
	render(
		<Providers>
			<DigestProgress
				phase="files"
				onCancel={onCancel}
				files={[
					{ chars: 10, cut: false, name: "agenda.docx", state: "done" },
					{ name: "slides.pptx", state: "reading" },
					{ name: "scan.pdf", reason: "scanned_pdf", state: "refused" },
					{ name: "oud.doc", reason: "legacy_format", state: "refused" },
				]}
			/>
		</Providers>,
	);
	expect(screen.getByTestId("project-digest-file-0").textContent).toContain(
		"read",
	);
	expect(
		screen.getByTestId("project-digest-file-2-reason").textContent,
	).toContain("scan");
	expect(
		screen.getByTestId("project-digest-file-3-reason").textContent,
	).toContain(".docx");
	expect(
		screen.getByTestId("project-digest-progress-status").textContent,
	).toContain("this device");
	fireEvent.click(screen.getByTestId("project-digest-cancel"));
	expect(onCancel).toHaveBeenCalled();
});

it("then one state while dembrane reads the material", () => {
	render(
		<Providers>
			<DigestProgress phase="material" files={[]} />
		</Providers>,
	);
	expect(screen.getByText("Reading your material")).toBeTruthy();
});
