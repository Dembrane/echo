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
import { CommonDropzone } from "./Dropzone";
import { AUDIO_ACCEPT } from "./UploadConversationDropzone";

beforeAll(setUpDom);
afterEach(cleanup);

const input = (container: HTMLElement) =>
	container.querySelector("input[type=file]") as HTMLInputElement;

const renderZone = (onDrop = vi.fn(), onReject = vi.fn()) => {
	const view = render(
		<Providers>
			<CommonDropzone
				accept={AUDIO_ACCEPT}
				onDrop={onDrop}
				onReject={onReject}
				acceptContent={<span>drop it</span>}
			>
				<span>pick audio</span>
			</CommonDropzone>
		</Providers>,
	);
	return { ...view, onDrop, onReject };
};

it("filters with the accept setting and never renders it as text", () => {
	const { container } = renderZone();
	expect(container.textContent).not.toContain("audio/mpeg");
	const accept = input(container).getAttribute("accept") ?? "";
	for (const part of ["audio/mpeg", "video/mp4", ".mp3", ".qta", ".m4a"])
		expect(accept).toContain(part);
	expect(screen.getByText("pick audio")).toBeTruthy();
});

it("takes an audio file by its type or its extension", async () => {
	const { container, onDrop, onReject } = renderZone();
	const byType = new File(["x"], "recording", { type: "audio/mpeg" });
	const byExtension = new File(["x"], "memo.qta", { type: "" });
	fireEvent.change(input(container), {
		target: { files: [byType, byExtension] },
	});
	await waitFor(() => expect(onDrop).toHaveBeenCalled());
	expect(onDrop.mock.calls[0][0].map((f: File) => f.name)).toEqual([
		"recording",
		"memo.qta",
	]);
	expect(onReject).not.toHaveBeenCalled();
});

it("rejects anything else itself, as an invalid type", async () => {
	const { container, onDrop, onReject } = renderZone();
	const pdf = new File(["%PDF"], "agenda.pdf", { type: "application/pdf" });
	fireEvent.change(input(container), { target: { files: [pdf] } });
	await waitFor(() => expect(onReject).toHaveBeenCalled());
	const [rejection] = onReject.mock.calls[0][0];
	expect(rejection.file.name).toBe("agenda.pdf");
	expect(rejection.errors[0].code).toBe("file-invalid-type");
	expect(onDrop.mock.calls.every((c) => c[0].length === 0)).toBe(true);
});
