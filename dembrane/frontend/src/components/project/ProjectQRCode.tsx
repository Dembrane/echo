import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, CopyButton, Skeleton, Stack, Text } from "@mantine/core";
import { CheckIcon, CopyIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useMemo, useRef } from "react";
import { PARTICIPANT_BASE_URL } from "@/config";
import { testId } from "@/lib/testUtils";
import { QRCode } from "../common/QRCode";

interface ProjectQRCodeProps {
	project?: Project;
}

// Where a participant link was handed out, carried as `utm_source` so PostHog
// auto-attributes the landing. Lets us split "came from a QR vs a copied link
// vs the printed host guide" the instant a participant lands.
export type ShareLinkSource =
	| "qr_scan"
	| "qr_click"
	| "copy_link"
	| "qr_download"
	| "host_guide"
	| "report"
	| "portal";

// eslint-disable-next-line react-refresh/only-export-components
export const useProjectSharingLink = (
	project?: Project,
	source?: ShareLinkSource,
) => {
	// biome-ignore lint/correctness/useExhaustiveDependencies: not an issue
	return useMemo(() => {
		if (!project) {
			return null;
		}

		// map the project.language to the language code
		const languageCode = {
			cs: "cs-CZ",
			"cs-CZ": "cs-CZ",
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
			uk: "uk-UA",
			"uk-UA": "uk-UA",
		}[
			project.language as
				| "en"
				| "nl"
				| "de"
				| "fr"
				| "es"
				| "it"
				| "uk"
				| "cs"
				| "en-US"
				| "nl-NL"
				| "de-DE"
				| "fr-FR"
				| "es-ES"
				| "it-IT"
				| "uk-UA"
				| "cs-CZ"
		];

		const baseLink = `${PARTICIPANT_BASE_URL}/${languageCode}/${project.id}/start`;
		if (!source) return baseLink;
		const params = new URLSearchParams({ utm_source: source });
		return `${baseLink}?${params.toString()}`;
	}, [project?.language, project?.id, source]);
};

export const ProjectQRCode = ({ project }: ProjectQRCodeProps) => {
	// Each surface gets its own utm_source. The QR's encoded value (scanned off
	// the screen) and its click target are distinct, so we can tell a scan from
	// a host clicking the code. The downloaded PNG is rendered from a separate
	// hidden QR so it carries its own `qr_download` tag instead of the on-screen
	// scan link.
	const scanLink = useProjectSharingLink(project, "qr_scan");
	const clickLink = useProjectSharingLink(project, "qr_click");
	const copyLink = useProjectSharingLink(project, "copy_link");
	const downloadLink = useProjectSharingLink(project, "qr_download");
	const downloadQrRef = useRef<HTMLDivElement>(null);

	const handleDownloadQR = () => {
		if (!downloadQrRef.current) return;
		const canvas = downloadQrRef.current.querySelector("canvas");
		if (!canvas) return;

		const downloadAnchor = document.createElement("a");
		downloadAnchor.download = `qr-${project?.name || "code"}.png`;
		downloadAnchor.href = canvas.toDataURL("image/png");
		downloadAnchor.click();
	};

	if (!scanLink) {
		return <Skeleton height={200} />;
	}

	if (!project?.is_conversation_allowed) {
		return (
			<Text size="sm">
				<Trans>Please enable participation to enable sharing</Trans>
			</Text>
		);
	}

	// QR on top, sharing actions stacked directly below it (the left column
	// of the portal overview card).
	return (
		<Stack gap="sm" align="center" w="100%">
			<QRCode
				value={scanLink}
				href={clickLink ?? undefined}
				className="h-auto w-full"
				{...testId("project-qr-code")}
			/>
			{/* Offscreen QR carrying the qr_download tag; only used to export the PNG. */}
			<div
				ref={downloadQrRef}
				aria-hidden
				className="pointer-events-none absolute -left-[9999px] top-0 h-64 w-64 print:hidden"
			>
				{downloadLink && <QRCode value={downloadLink} inverted={false} />}
			</div>
			<Stack gap="xs" w="100%">
				<CopyButton value={copyLink ?? ""} timeout={2000}>
					{({ copied, copy }) => (
						<Button
							size="sm"
							onClick={copy}
							leftSection={
								copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />
							}
							{...testId("project-copy-link-button")}
						>
							{copied ? t`Copied` : t`Copy link`}
						</Button>
					)}
				</CopyButton>
				<Button
					size="sm"
					onClick={handleDownloadQR}
					leftSection={<DownloadSimpleIcon size={20} />}
					{...testId("project-download-qr-button")}
				>
					<Trans>Download QR code</Trans>
				</Button>
			</Stack>
		</Stack>
	);
};
