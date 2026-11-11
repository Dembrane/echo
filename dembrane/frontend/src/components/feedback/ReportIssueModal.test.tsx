// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const { voiceOptions } = vi.hoisted(() => ({ voiceOptions: vi.fn() }));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("./hooks", () => ({
	IssueReportError: class extends Error {},
	useSubmitIssueReportMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/components/voice/useVoiceTranscription", () => ({
	useVoiceTranscription: (options: unknown) => {
		voiceOptions(options);
		return { status: "idle" };
	},
}));
vi.mock("@/components/voice/VoiceInputButton", () => ({
	VoiceInputButton: () => null,
}));
vi.mock("@/components/voice/VoiceInputError", () => ({
	VoiceInputError: () => null,
}));
vi.mock("@/components/voice/VoiceRecordingBar", () => ({
	VoiceRecordingBar: () => null,
}));

import { ReportIssueModal } from "./ReportIssueModal";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
});

afterEach(() => {
	cleanup();
	voiceOptions.mockReset();
});

it("dictation inside a project bills the workspace, so a project viewer is not refused", () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ReportIssueModal
					opened
					onClose={() => {}}
					workspaceId="w1"
					projectId="p1"
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	const options = voiceOptions.mock.calls.at(-1)?.[0] as Record<
		string,
		unknown
	>;
	expect(options.purpose).toBe("issue_report");
	expect(options.workspaceId).toBe("w1");
	expect(options.projectId).toBeUndefined();
});
