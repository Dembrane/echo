// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { VOICE_TRANSCRIBE_TIMEOUT_MS } from "@/components/voice/voiceInput";
import { api, transcribeStateless } from "./api";

/** The field names below are the endpoint's, not ours: `file` is the multipart
 * upload FastAPI binds to UploadFile, and the rest are Form fields on
 * transcribe_stateless. Renaming any of them here is a silent 422. */

afterEach(() => {
	vi.restoreAllMocks();
});

const postSpy = () =>
	vi.spyOn(api, "post").mockResolvedValue({
		note: "",
		transcript: "hello",
	} as never);

it("posts one whole file under the field names the endpoint reads", async () => {
	const post = postSpy();
	await transcribeStateless({
		file: new Blob(["audio"], { type: "audio/webm" }),
		filename: "voice-note.webm",
		hotwords: "dembrane, Eindhoven",
		language: "nl",
		projectId: "project-1",
	});

	const [url, body, config] = post.mock.calls[0];
	expect(url).toBe("/stateless/transcribe");
	const form = body as FormData;
	expect(form.get("project_id")).toBe("project-1");
	expect(form.get("language")).toBe("nl");
	expect(form.get("hotwords")).toBe("dembrane, Eindhoven");
	const file = form.get("file") as File;
	expect(file.name).toBe("voice-note.webm");
	expect(file.type).toBe("audio/webm");
	// One part, not many: this endpoint has no chunked form.
	expect(form.getAll("file")).toHaveLength(1);
	expect(config?.timeout).toBe(VOICE_TRANSCRIBE_TIMEOUT_MS);
});

it("omits the optional fields rather than sending empty ones", async () => {
	const post = postSpy();
	await transcribeStateless({
		file: new Blob(["audio"], { type: "audio/webm" }),
		filename: "voice-note.webm",
		projectId: "project-1",
	});

	const form = post.mock.calls[0][1] as FormData;
	expect(form.has("language")).toBe(false);
	expect(form.has("hotwords")).toBe(false);
});

it("carries the abort signal so a cancelled recording drops its upload", async () => {
	const post = postSpy();
	const controller = new AbortController();
	await transcribeStateless({
		file: new Blob(["audio"], { type: "audio/webm" }),
		filename: "voice-note.webm",
		projectId: "project-1",
		signal: controller.signal,
	});

	expect(post.mock.calls[0][2]?.signal).toBe(controller.signal);
});
