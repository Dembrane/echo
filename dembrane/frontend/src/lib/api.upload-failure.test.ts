// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import axios from "axios";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	api,
	apiNoAuth,
	initiateAndUploadConversationChunk,
	UploadFailedError,
} from "./api";

vi.mock("@/components/common/Toaster", () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

beforeEach(() => {
	i18n.load("en", {});
	i18n.activate("en");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("a file that fails at storage rejects the upload, is deleted, and is never finished", async () => {
	const ids: Record<string, string> = {
		"bad.mp3": "c-bad",
		"good.mp3": "c-good",
	};
	const post = vi
		.spyOn(apiNoAuth, "post")
		.mockImplementation(async (url: string, body?: unknown) => {
			if (url.endsWith("/conversations/initiate")) {
				const name = (body as { name: string }).name;
				return { id: ids[name] };
			}
			if (url.endsWith("/get-upload-url")) {
				return {
					chunk_id: "k",
					fields: {},
					file_url: "f",
					upload_url: url.includes("c-bad") ? "https://bad" : "https://good",
				};
			}
			return {};
		});
	vi.spyOn(axios, "post").mockImplementation(async (url: string) => {
		if (url === "https://bad") throw new Error("Network Error");
		return {};
	});
	const del = vi.spyOn(api, "delete").mockResolvedValue({});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});

	const settled = initiateAndUploadConversationChunk({
		chunks: [
			new File(["a"], "good.mp3", { type: "audio/mpeg" }),
			new File(["b"], "bad.mp3", { type: "audio/mpeg" }),
		],
		namePrefix: "",
		pin: "",
		projectId: "p1",
		tagIdList: [],
		timestamps: [new Date(), new Date()],
	}).then(
		() => null,
		(e: unknown) => e,
	);
	await vi.runAllTimersAsync();
	const error = await settled;

	expect(error).toBeInstanceOf(UploadFailedError);
	const failed = error as UploadFailedError;
	expect(failed.failed.map((f) => f.name)).toEqual(["bad.mp3"]);
	expect(failed.succeeded).toBe(1);

	expect(del).toHaveBeenCalledTimes(1);
	expect(del).toHaveBeenCalledWith("/conversations/c-bad");

	const finished = post.mock.calls
		.map(([url]) => url as string)
		.filter((url) => url.endsWith("/finish"));
	expect(finished).toEqual(["/participant/conversations/c-good/finish"]);
});
