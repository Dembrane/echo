import { Trans } from "@lingui/react/macro";
import { Skeleton, Text } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { EventPrintoutsItem, QRShare } from "@/components/sharing/Share";
import { PARTICIPANT_BASE_URL } from "@/config";
import { type PortalShareMethod, track } from "@/lib/analytics/events";

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
	const { workspaceId = "" } = useParams();
	// Each surface gets its own utm_source: the code on screen (scanned), Open
	// link (a host clicking through), Copy link, and the downloaded PNG.
	const scanLink = useProjectSharingLink(project, "qr_scan");
	const clickLink = useProjectSharingLink(project, "qr_click");
	const copyLink = useProjectSharingLink(project, "copy_link");
	const downloadLink = useProjectSharingLink(project, "qr_download");

	if (!scanLink || !copyLink) {
		return <Skeleton height={200} />;
	}

	if (!project?.is_conversation_allowed) {
		return (
			<Text size="sm">
				<Trans>Please enable participation to enable sharing</Trans>
			</Text>
		);
	}

	// The portal link handed on: copied, the QR saved as an image, or printed on the
	// event sheets (the QR people scan). Opening the link is the host testing, not sharing.
	const shared = (method: PortalShareMethod) => {
		if (project?.id)
			track("portal_link_shared", { method, project_id: project.id });
	};

	return (
		<QRShare
			onAction={(action) => {
				if (action === "copy" || action === "download") shared(action);
			}}
			links={{
				download: downloadLink ?? undefined,
				open: clickLink ?? undefined,
				scan: scanLink,
				url: copyLink,
			}}
			fileName={project.name || "code"}
			extras={
				project.id && (
					<EventPrintoutsItem
						workspaceId={workspaceId}
						projectId={project.id}
						onClick={() => shared("qr")}
					/>
				)
			}
		/>
	);
};
