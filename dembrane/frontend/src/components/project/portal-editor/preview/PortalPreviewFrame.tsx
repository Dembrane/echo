import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, NativeSelect, Stack, Text, Title } from "@mantine/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PARTICIPANT_BASE_URL } from "@/config";
import {
	isReadyMessage,
	originOf,
	type PreviewMessage,
	type PreviewScreen,
} from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";
import { LOCALE_FOR_LANGUAGE } from "./buildPreviewMessage";

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
	/** Shown beside the phone, as on the Privacy page's anonymisation example. */
	aside?: ReactNode;
	/** Where the frame loads the portal from; the configured portal by default. */
	portalUrl?: string;
}

/**
 * A phone showing the participant screen a page changes, with the host's values as they
 * are now (ECHO-1060). The portal draws it in a frame of its own (its preview mode), told
 * what to show by postMessage: sent only to the portal's origin, and answered only when
 * the answer comes from that frame and that origin.
 *
 * The sandbox allows two things: scripts, and keeping the portal's own origin
 * (allow-same-origin). The origin is needed on both sides: without it the frame's origin is
 * "null", so this page would refuse its ready message and could not address it, and the
 * portal's code could not read its own storage (language, preferences). It is the portal's
 * origin, not the dashboard's, so the frame still cannot reach this page. Everything else
 * stays refused by the sandbox: forms, pop-ups, top navigation, modals. Devices are refused
 * by the frame's permissions policy (no allow attribute, so a cross-origin frame gets no
 * microphone or camera) and by the portal's own lockDown. Props in, callbacks out.
 */
export const PortalPreviewFrame = ({
	projectId,
	message,
	screens,
	onScreen,
	aside,
	portalUrl = PARTICIPANT_BASE_URL,
}: PortalPreviewFrameProps) => {
	const frame = useRef<HTMLIFrameElement>(null);
	const [ready, setReady] = useState(false);
	const portalOrigin = originOf(portalUrl);
	const locale = LOCALE_FOR_LANGUAGE[message.project.language] ?? "en-US";
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

	const isExample = message.result?.source === "example";

	return (
		<Stack gap="sm" {...testId("portal-preview")}>
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
			{isExample && (
				<Text size="sm" maw={360} {...testId("portal-preview-example-note")}>
					<Trans>
						Example: a made-up conversation, to show the shape. Real replies are
						built from what participants say.
					</Trans>
				</Text>
			)}
			<Stack gap="md">
				<Box
					w={360}
					maw="100%"
					h={680}
					style={{
						background: "var(--app-surface)",
						border: "var(--app-stroke) solid var(--app-rule-color)",
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
							sandbox="allow-scripts allow-same-origin"
							referrerPolicy="no-referrer"
							className="block h-full w-full border-0"
							{...testId("portal-preview-frame")}
						/>
					)}
				</Box>
				{aside}
			</Stack>
		</Stack>
	);
};
