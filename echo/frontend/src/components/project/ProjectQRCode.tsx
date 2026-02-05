import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	CopyButton,
	Group,
	Paper,
	rem,
	Skeleton,
	Text,
} from "@mantine/core";
import {
	IconCheck,
	IconCopy,
	IconDownload,
	IconExternalLink,
	IconPresentation,
	IconShare,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useMemo } from "react";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useAppPreferences } from "@/hooks/useAppPreferences";
import { testId } from "@/lib/testUtils";
import { QRCode } from "../common/QRCode";

interface ProjectQRCodeProps {
	project?: Project;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useProjectSharingLink = (project?: Project) => {
	const { preferences } = useAppPreferences();

	// biome-ignore lint/correctness/useExhaustiveDependencies: not an issue
	return useMemo(() => {
		if (!project) {
			return null;
		}

		// map the project.language to the language code
		const languageCode = {
			de: "de-DE",
			"de-DE": "de-DE",
			en: "en-US",
			"en-US": "en-US",
			es: "es-ES",
			"es-ES": "es-ES",
			fr: "fr-FR",
			"fr-FR": "fr-FR",
			it: "it-IT",
			"it-IT": "it-IT",
			nl: "nl-NL",
			"nl-NL": "nl-NL",
		}[
			project.language as
				| "en"
				| "nl"
				| "de"
				| "fr"
				| "es"
				| "it"
				| "en-US"
				| "nl-NL"
				| "de-DE"
				| "fr-FR"
				| "es-ES"
				| "it-IT"
		];

		// Include theme in URL so participant portal uses the same theme
		const baseLink = `${PARTICIPANT_BASE_URL}/${languageCode}/${project.id}/start`;
		const theme = preferences.fontFamily;
		const link = `${baseLink}?theme=${theme}`;
		return link;
	}, [project?.language, project?.id, preferences.fontFamily]);
};

export const ProjectQRCode = ({ project }: ProjectQRCodeProps) => {
	const link = useProjectSharingLink(project);
	const [qrHovered, setQrHovered] = useState(false);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const qrRef = useRef<HTMLDivElement>(null);

	const handleOpenHostGuide = () => {
		if (!project) return;
		// Open quick start page in new tab
		const hostGuideUrl = `/projects/${project.id}/host-guide`;
		window.open(hostGuideUrl, "_blank");
	};

	const handleDownloadQR = () => {
		if (!qrRef.current) return;
		const canvas = qrRef.current.querySelector("canvas");
		if (!canvas) return;

		const downloadLink = document.createElement("a");
		downloadLink.download = `qr-${project?.name || "code"}.png`;
		downloadLink.href = canvas.toDataURL("image/png");
		downloadLink.click();
		setContextMenu(null);
	};

	const handleQRContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY });
	};

	// Close context menu on click outside or escape
	useEffect(() => {
		if (!contextMenu) return;
		const handleClick = () => setContextMenu(null);
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setContextMenu(null);
		};
		document.addEventListener("click", handleClick);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("click", handleClick);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [contextMenu]);

	if (!link) {
		return <Skeleton height={200} />;
	}

	let canShare = false;
	try {
		if (navigator.canShare) {
			canShare = navigator.canShare({
				title: "Join the conversation on Dembrane",
				url: link,
			});
		}
	} catch (e) {
		console.error(e);
	}

	// Quick start is only available for supported languages
	const supportedLanguages = ["en", "nl", "de", "fr", "es", "it", "en-US", "nl-NL", "de-DE", "fr-FR", "es-ES", "it-IT"];
	const showQuickStart = project?.language && supportedLanguages.includes(project.language);

	return (
		<Paper
			p="md"
			className="relative flex h-full flex-col items-center justify-center"
		>
			{project?.is_conversation_allowed ? (
				<Group align="center" justify="center" gap="lg">
					{/* Interactive QR Code */}
					<Box
						ref={qrRef}
						className="relative h-auto w-full min-w-[80px] max-w-[128px] cursor-pointer overflow-hidden rounded-lg bg-white transition-all"
						onMouseEnter={() => setQrHovered(true)}
						onMouseLeave={() => setQrHovered(false)}
						onClick={() => window.open(link, "_blank")}
						onContextMenu={handleQRContextMenu}
						{...testId("project-qr-code")}
					>
						<QRCode value={link} />
						{/* Hover overlay */}
						<div
							className="absolute inset-0 flex items-center justify-center rounded-lg transition-all"
							style={{
								backgroundColor: qrHovered
									? "rgba(65, 105, 225, 0.85)"
									: "transparent",
								opacity: qrHovered ? 1 : 0,
							}}
						>
							<IconExternalLink
								style={{ width: rem(32), height: rem(32) }}
								color="white"
							/>
						</div>
					</Box>
					<div className="flex flex-col flex-wrap gap-2">
						{showQuickStart && (
							<Button
								size="sm"
								variant="outline"
								onClick={handleOpenHostGuide}
								rightSection={<IconPresentation style={{ width: rem(16) }} />}
								{...testId("project-share-button")}
							>
								<Trans>Open guide</Trans>
							</Button>
						)}
						<CopyButton value={link} timeout={2000}>
							{({ copied, copy }) => (
								<Button
									size="sm"
									variant="outline"
									onClick={copy}
									rightSection={
										copied ? (
											<IconCheck style={{ width: rem(16) }} />
										) : (
											<IconCopy style={{ width: rem(16) }} />
										)
									}
									{...testId("project-copy-link-button")}
								>
									{copied ? t`Copied` : t`Copy link`}
								</Button>
							)}
						</CopyButton>
						{/* Share button - commented out
						{canShare && (
							<Button
								className="lg:hidden"
								size="sm"
								rightSection={<IconShare style={{ width: rem(16) }} />}
								variant="outline"
								onClick={async () => {
									await navigator.share({
										title: t`Join ${project?.default_conversation_title ?? "the conversation"} on Dembrane`,
										url: link,
									});
								}}
							>
								<Trans>Share</Trans>
							</Button>
						)}
						*/}
					</div>
				</Group>
			) : (
				<Text size="sm">
					<Trans>Please enable participation to enable sharing</Trans>
				</Text>
			)}

			{/* QR Code context menu */}
			{contextMenu && (
				<div
					className="fixed z-50 rounded border border-gray-200 bg-white py-1 shadow-lg"
					style={{ left: contextMenu.x, top: contextMenu.y }}
				>
					<button
						type="button"
						className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-gray-100"
						onClick={handleDownloadQR}
					>
						<IconDownload style={{ width: rem(16) }} />
						<Trans>Download QR code</Trans>
					</button>
				</div>
			)}
		</Paper>
	);
};
