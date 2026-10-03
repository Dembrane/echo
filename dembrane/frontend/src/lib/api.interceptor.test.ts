// @vitest-environment jsdom
import type { AxiosAdapter } from "axios";
import { afterEach, expect, it, vi } from "vitest";
import { api, apiNoAuth, initiateAndUploadConversationChunk } from "./api";

vi.mock("@/components/common/Toaster", () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

const refusing = (status: number) => {
	const adapter = vi.fn<AxiosAdapter>(async (config) =>
		Promise.reject(
			Object.assign(new Error(`Request failed with status code ${status}`), {
				config,
				isAxiosError: true,
				response: { config, data: {}, headers: {}, status, statusText: "" },
			}),
		),
	);
	return adapter;
};

it.each([401, 403])(
	"a %i is sent once and rejected, not retried",
	async (status) => {
		const adapter = refusing(status);
		await expect(
			api.post("/projects/p/clone", {}, { adapter }),
		).rejects.toMatchObject({ response: { status } });
		expect(adapter).toHaveBeenCalledTimes(1);
	},
);

it("an upload without a prefix is named after the file alone", async () => {
	// Held open: only the initiate call matters here.
	const post = vi
		.spyOn(apiNoAuth, "post")
		.mockReturnValue(new Promise(() => {}));
	void initiateAndUploadConversationChunk({
		chunks: [new File(["a"], "sofia.mp3", { type: "audio/mpeg" })],
		namePrefix: "",
		pin: "",
		projectId: "p1",
		tagIdList: [],
		timestamps: [new Date()],
	});
	await vi.waitFor(() => expect(post).toHaveBeenCalled());
	const [url, body] = post.mock.calls[0];
	expect(url).toBe("/participant/projects/p1/conversations/initiate");
	expect((body as { name: string }).name).toBe("sofia.mp3");
});
