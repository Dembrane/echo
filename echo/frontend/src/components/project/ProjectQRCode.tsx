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
	IconExternalLink,
	IconShare,
} from "@tabler/icons-react";
import { useMemo } from "react";
import { PARTICIPANT_BASE_URL } from "@/config";
import { QRCode } from "../common/QRCode";

interface ProjectQRCodeProps {
	project?: Project;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useProjectSharingLink = (project?: Project) => {
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

		const link = `${PARTICIPANT_BASE_URL}/${languageCode}/${project.id}/start`;
		return link;
	}, [project?.language, project?.id]);
};

export const ProjectQRCode = ({ project }: ProjectQRCodeProps) => {
	const link = useProjectSharingLink(project);

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

	return (
		<Paper
			p="md"
			className="relative flex h-full flex-col items-center justify-center"
		>
			{project?.is_conversation_allowed ? (
				<Group align="center" justify="center" gap="lg">
					<Box className="h-auto w-full min-w-[80px] max-w-[128px] rounded-lg bg-white">
						<QRCode value={link} />
					</Box>
					<div className="flex flex-col flex-wrap gap-2">
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
								>
									{copied ? t`Copied` : t`Copy link`}
								</Button>
							)}
						</CopyButton>
						<Button
							size="sm"
							variant="outline"
							onClick={() => window.open(link, "_blank")}
							rightSection={<IconExternalLink style={{ width: rem(16) }} />}
						>
							<Trans>Go to portal</Trans>
						</Button>
					</div>
				</Group>
			) : (
				<Text size="sm">
					<Trans>Please enable participation to enable sharing</Trans>
				</Text>
			)}
		</Paper>
	);
};
