import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, CopyButton, rem, Skeleton, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy, IconDownload } from "@tabler/icons-react";
import { useMemo, useRef } from "react";
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

		// Include theme in URL so participant portal uses the same theme
		const baseLink = `${PARTICIPANT_BASE_URL}/${languageCode}/${project.id}/start`;
		const theme = preferences.fontFamily;
		const link = `${baseLink}?theme=${theme}`;
		return link;
	}, [project?.language, project?.id, preferences.fontFamily]);
};

export const ProjectQRCode = ({ project }: ProjectQRCodeProps) => {
	const link = useProjectSharingLink(project);
	const qrRef = useRef<HTMLDivElement>(null);

	const handleDownloadQR = () => {
		if (!qrRef.current) return;
		const canvas = qrRef.current.querySelector("canvas");
		if (!canvas) return;

		const downloadLink = document.createElement("a");
		downloadLink.download = `qr-${project?.name || "code"}.png`;
		downloadLink.href = canvas.toDataURL("image/png");
		downloadLink.click();
	};

	if (!link) {
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
				value={link}
				href={link}
				ref={qrRef}
				className="h-auto w-full"
				{...testId("project-qr-code")}
			/>
			<Stack gap="xs" w="100%">
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
				<Button
					size="sm"
					variant="outline"
					onClick={handleDownloadQR}
					rightSection={<IconDownload style={{ width: rem(16) }} />}
					{...testId("project-download-qr-button")}
				>
					<Trans>Download QR code</Trans>
				</Button>
			</Stack>
		</Stack>
	);
};
