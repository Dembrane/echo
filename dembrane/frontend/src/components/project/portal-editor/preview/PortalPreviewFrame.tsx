import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, NativeSelect, Stack, Text, Title } from "@mantine/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PARTICIPANT_BASE_URL, PREVIEW_FRAME_NAME } from "@/config";
import { localeForLanguage } from "@/lib/locale";
import {
	isReadyMessage,
	originOf,
	type PreviewMessage,
	type PreviewScreen,
} from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";

export const screenLabel = (screen: PreviewScreen): string => {
	switch (screen) {
		case "landing":
			return t`Start screen`;
		case "tutorial":
			return t`Tutorial cards`;
		case "privacy":
			return t`Privacy card`;
		case "form":
			return t`Name and tags`;
		case "recording":
			return t`Recording screen`;
		case "explore":
			return t`Explore reply`;
		case "verify-topics":
			return t`Verify topics`;
		case "verify-summary":
			return t`Draft to approve`;
		case "finish":
			return t`Thank you page`;
	}
};

interface PortalPreviewFrameProps {
	projectId: string;
	message: PreviewMessage;
	/** The screens this page can show, for the picker. */
	screens: readonly PreviewScreen[];
	onScreen: (screen: PreviewScreen) => void;
	/** Shown above the phone: the Explore and Verify pages' "Try it" (ECHO-1061). */
	action?: ReactNode;
	/** Where the frame loads the portal from; the configured portal by default. */
	portalUrl?: string;
}

/**
 * A phone showing the participant screen a page changes, with the host's values as they
 * are now (ECHO-1060). The portal draws it in a frame of its own (its preview mode), told
 * what to show by postMessage: sent only to the portal's origin, and answered only when
 * the answer comes from that frame and that origin. The host can click through it: type in
 * its fields and press Continue (ECHO-1062); the portal answers its own requests from
 * made-up data inside the frame, so nothing leaves it.
 *
 * The frame's attributes, each for a reason:
 * - sandbox "allow-scripts": the portal is a script.
 * - sandbox "allow-same-origin": the frame keeps the portal's own origin. Without it the
 *   origin is "null", so this page would refuse its ready message and could not address
 *   it, and the portal's code could not read its own storage (language, preferences). It
 *   is the portal's origin, not the dashboard's, so the frame still cannot reach this page.
 * - sandbox "allow-forms": without it the browser blocks a form's submit event, so the
 *   start form's Continue would do nothing. The portal's preview mode cancels every
 *   submission's default (lockDown), so a form never sends anything.
 * Everything else stays refused by the sandbox: pop-ups, top navigation, modals, downloads.
 * - no "allow" attribute: a cross-origin frame then gets no microphone, camera or screen
 *   (the permissions policy), and lockDown refuses them too.
 * - name: the portal treats any page loaded under this name as the preview, so even a page
 *   the frame were sent to stays locked down.
 * - referrerPolicy "no-referrer": the portal is not told the dashboard's address.
 *
 * The phone takes the height it is given, up to a phone's, so the whole of it fits in view
 * beside the options. Props in, callbacks out.
 */
export const PortalPreviewFrame = ({
	projectId,
	message,
	screens,
	onScreen,
	action,
	portalUrl = PARTICIPANT_BASE_URL,
}: PortalPreviewFrameProps) => {
	const frame = useRef<HTMLIFrameElement>(null);
	const [ready, setReady] = useState(false);
	const portalOrigin = originOf(portalUrl);
	const locale = localeForLanguage(message.project.language);
	const src = portalOrigin
		? `${portalUrl.replace(/\/$/, "")}/${locale}/${encodeURIComponent(projectId)}/preview`
		: null;

	// A new language loads a new page, which says it is ready again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: src names the page the frame holds
	useEffect(() => setReady(false), [src]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			if (!portalOrigin || event.origin !== portalOrigin) return;
			if (isReadyMessage(event.data)) setReady(true);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [portalOrigin]);

	useEffect(() => {
		if (!ready || !portalOrigin) return;
		frame.current?.contentWindow?.postMessage(message, portalOrigin);
	}, [ready, message, portalOrigin]);

	// The note under the title names where the open screen's result comes from.
	const source =
		message.screen === "explore"
			? message.explore?.source
			: message.screen === "verify-summary"
				? message.verify?.source
				: undefined;

	return (
		<Stack
			gap="sm"
			mih={0}
			style={{ flex: "1 1 auto" }}
			{...testId("portal-preview")}
		>
			<Group justify="space-between" align="end" wrap="wrap" gap="sm">
				<Title order={4}>
					<Trans>Preview</Trans>
				</Title>
				{screens.length > 1 && (
					<NativeSelect
						aria-label={t`Screen`}
						size="xs"
						value={message.screen}
						onChange={(e) => onScreen(e.currentTarget.value as PreviewScreen)}
						data={screens.map((s) => ({ label: screenLabel(s), value: s }))}
						{...testId("portal-preview-screen")}
					/>
				)}
			</Group>
			<Text size="sm" className="app-muted" maw={360}>
				<Trans>
					What participants see, with your changes, before they are saved.
				</Trans>
			</Text>
			{source === "example" && (
				<Text size="sm" maw={360} {...testId("portal-preview-example-note")}>
					<Trans>
						Example: a made-up conversation, to show the shape. Real replies are
						built from what participants say.
					</Trans>
				</Text>
			)}
			{source === "model" && (
				<Text size="sm" maw={360} {...testId("portal-preview-sample-note")}>
					<Trans>
						Made by dembrane from a sample conversation, with your settings.
					</Trans>
				</Text>
			)}
			{action}
			<Box
				w={360}
				maw="100%"
				mih={400}
				mah={680}
				style={{
					background: "var(--app-surface)",
					border: "var(--app-stroke) solid var(--app-rule-color)",
					display: "flex",
					flex: "1 1 680px",
					overflow: "hidden",
				}}
				data-screen={message.screen}
				data-ready={ready || undefined}
				{...testId("portal-preview-phone")}
			>
				{src && (
					<iframe
						ref={frame}
						key={src}
						src={src}
						title={t`Portal preview: ${screenLabel(message.screen)}`}
						name={PREVIEW_FRAME_NAME}
						sandbox="allow-scripts allow-same-origin allow-forms"
						referrerPolicy="no-referrer"
						className="block min-h-0 w-full flex-1 border-0"
						{...testId("portal-preview-frame")}
					/>
				)}
			</Box>
		</Stack>
	);
};
