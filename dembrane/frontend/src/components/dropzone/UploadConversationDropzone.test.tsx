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
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { UploadFailedError } from "@/lib/api";
import { UploadConversationDropzone } from "./UploadConversationDropzone";

vi.mock("@/lib/api", () => ({
	UploadFailedError: class UploadFailedError extends Error {
		failed: { name: string; error: Error }[];
		constructor(failed: { name: string; error: Error }[]) {
			super("failed");
			this.failed = failed;
		}
	},
}));

const uploader = vi.hoisted(() => ({
	error: null as Error | null,
	isError: false,
	isPending: false,
	isSuccess: false,
	isUploading: false,
	resetUpload: () => {},
	uploadErrors: {} as Record<string, string>,
	uploadFiles: (() => {}) as (...args: unknown[]) => void,
	uploadProgress: {} as Record<string, number>,
}));
const recording = vi.hoisted(() => ({
	data: {
		audio_seconds_left: 0,
		file_limit_seconds: 3600,
		free: true,
	} as Record<string, unknown> | undefined,
}));

const dropped = vi.hoisted(() => ({
	files: [] as { name: string; type: string }[],
}));

vi.mock("./hooks", () => ({ useConversationUploader: () => uploader }));
vi.mock("./Dropzone", () => ({
	CommonDropzone: ({ onDrop }: { onDrop: (files: File[]) => void }) => (
		<button
			type="button"
			onClick={() =>
				onDrop(
					dropped.files.map(
						(f) => new File([new Uint8Array(6000)], f.name, { type: f.type }),
					),
				)
			}
		>
			drop
		</button>
	),
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ isLoading: false }),
}));
vi.mock("@/hooks/useProjectRecording", () => ({
	useProjectRecording: () => recording,
}));
vi.mock("@/lib/mediaDuration", () => ({ readMediaSeconds: async () => 20 }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@posthog/react", () => ({ usePostHog: () => null }));
vi.mock("react-router", () => ({
	useLocation: () => ({ pathname: "/w/w1/projects/p1/overview" }),
	useParams: () => ({ workspaceId: "w1" }),
}));
vi.mock("../common/Toaster", () => ({
	toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const tierLimit = (limit: string) =>
	Object.assign(new Error("402"), {
		response: {
			data: {
				code: "billing.tier_limit",
				detail: { error: "FREE_TIER_LIMIT", limit },
				params: { limit },
			},
			status: 402,
		},
	});

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
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
	globalThis.ResizeObserver =
		globalThis.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

beforeEach(() => {
	dropped.files = [{ name: "a.mp3", type: "audio/mpeg" }];
	Object.assign(uploader, {
		error: null,
		isError: false,
		isPending: false,
		isSuccess: false,
		isUploading: false,
		uploadErrors: {},
		uploadFiles: vi.fn(),
		uploadProgress: {},
	});
	recording.data = {
		audio_seconds_left: 0,
		file_limit_seconds: 3600,
		free: true,
	};
});

afterEach(cleanup);

const renderDropzone = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<UploadConversationDropzone projectId="p1" />
			</MantineProvider>
		</I18nProvider>,
	);

const openAndPick = async () => {
	fireEvent.click(screen.getByTestId("conversation-upload-button"));
	fireEvent.click(await screen.findByText("drop"));
	return screen.findByTestId("conversation-upload-files-button");
};

it("disables Upload files once every selected file is refused", async () => {
	renderDropzone();
	const button = await openAndPick();
	expect((button as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(button);
	await screen.findByText(/You have 0 s of recording left this month/);
	await waitFor(() =>
		expect(
			(
				screen.getByTestId(
					"conversation-upload-files-button",
				) as HTMLButtonElement
			).disabled,
		).toBe(true),
	);
	expect(uploader.uploadFiles).not.toHaveBeenCalled();
});

it("keeps Upload files enabled when some files can still upload", async () => {
	recording.data = {
		audio_seconds_left: 3600,
		file_limit_seconds: 3600,
		free: true,
	};
	renderDropzone();
	const button = await openAndPick();
	fireEvent.click(button);
	await waitFor(() => expect(uploader.uploadFiles).toHaveBeenCalled());
	expect((button as HTMLButtonElement).disabled).toBe(false);
});

const renderFailed = (error: Error) => {
	Object.assign(uploader, { error, isError: true, isUploading: true });
	renderDropzone();
	fireEvent.click(screen.getByTestId("conversation-upload-button"));
};

it("hides Try again when every failure is a free limit refusal", async () => {
	renderFailed(
		new UploadFailedError(
			[{ error: tierLimit("audio_month"), name: "a.mp3" }],
			0,
		),
	);
	await screen.findByTestId("conversation-upload-back-button");
	expect(screen.queryByTestId("conversation-upload-retry-button")).toBeNull();
});

it("keeps Try again when a failure is not a free limit refusal", async () => {
	renderFailed(
		new UploadFailedError(
			[
				{ error: tierLimit("audio_month"), name: "a.mp3" },
				{ error: new Error("network"), name: "b.mp3" },
			],
			0,
		),
	);
	expect(
		await screen.findByTestId("conversation-upload-retry-button"),
	).toBeTruthy();
});

const uploadedChunks = () =>
	(uploader.uploadFiles as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
		.chunks as File[];

it("takes an Apple Voice Memo and uploads it as m4a", async () => {
	recording.data = { free: false };
	dropped.files = [{ name: "New Recording.qta", type: "video/quicktime" }];
	renderDropzone();
	const button = await openAndPick();
	await screen.findByText("New Recording.m4a");
	fireEvent.click(button);
	await waitFor(() => expect(uploader.uploadFiles).toHaveBeenCalled());
	const [file] = uploadedChunks();
	expect(file.name).toBe("New Recording.m4a");
	expect(file.type).toBe("audio/m4a");
	expect(file.size).toBe(6000);
});

it("takes a .qta whatever its case or reported type", async () => {
	recording.data = { free: false };
	dropped.files = [{ name: "Memo.QTA", type: "" }];
	renderDropzone();
	const button = await openAndPick();
	fireEvent.click(button);
	await waitFor(() => expect(uploader.uploadFiles).toHaveBeenCalled());
	expect(uploadedChunks()[0].name).toBe("Memo.m4a");
});

it("still refuses a video that is not a voice memo", async () => {
	dropped.files = [{ name: "clip.mov", type: "video/quicktime" }];
	renderDropzone();
	fireEvent.click(screen.getByTestId("conversation-upload-button"));
	fireEvent.click(await screen.findByText("drop"));
	await waitFor(() =>
		expect(screen.queryByTestId("conversation-upload-files-button")).toBeNull(),
	);
});
