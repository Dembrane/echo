import { t } from "@lingui/core/macro";
import { Alert, Button, CopyButton, Stack, Text } from "@mantine/core";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useEffect, useMemo, useRef } from "react";
import { detectInAppBrowser } from "@/lib/inAppBrowser";
import { testId } from "@/lib/testUtils";

const APP_NAMES = {
	facebook: "Facebook",
	instagram: "Instagram",
	linkedin: "LinkedIn",
} as const;

/** Asks participants inside a social app's browser to reopen the portal where the mic works. */
export const InAppBrowserNotice = ({ projectId }: { projectId?: string }) => {
	const inApp = useMemo(
		() => detectInAppBrowser(globalThis.navigator?.userAgent ?? ""),
		[],
	);

	// Once per mount, so StrictMode's second effect run in dev does not double count.
	const captured = useRef(false);
	useEffect(() => {
		if (inApp && !captured.current) {
			captured.current = true;
			posthog.capture("portal_in_app_browser_detected", {
				app: inApp.app,
				os: inApp.os,
				project_id: projectId,
			});
		}
	}, [inApp, projectId]);

	if (!inApp) return null;

	const appName = APP_NAMES[inApp.app];
	const browserName =
		inApp.os === "ios" ? "Safari" : inApp.os === "android" ? "Chrome" : null;

	// Padding lives here, so a real browser gets no element at all and nothing moves.
	return (
		<div className="px-4 pt-4">
			<Alert
				color="yellow"
				className="w-full text-start"
				{...testId("portal-in-app-browser-alert")}
			>
				<Stack gap="sm">
					<Text>{t`Your microphone may not work inside ${appName}.`}</Text>
					<Text>
						{browserName
							? t`Open this page in ${browserName} from the app's menu, or copy the link.`
							: t`Open this page in your browser from the app's menu, or copy the link.`}
					</Text>
					<CopyButton value={window.location.href} timeout={2000}>
						{({ copied, copy }) => (
							<Button
								leftSection={
									copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />
								}
								onClick={copy}
								className="self-start"
								{...testId("portal-in-app-browser-copy-button")}
							>
								{copied ? t`Copied` : t`Copy link`}
							</Button>
						)}
					</CopyButton>
				</Stack>
			</Alert>
		</div>
	);
};
