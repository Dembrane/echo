import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  Box,
  Button,
  CopyButton,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  rem,
} from "@mantine/core";
import { IconCheck, IconCopy, IconShare } from "@tabler/icons-react";
import { QRCode } from "../common/QRCode";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useMemo } from "react";

interface ProjectQRCodeProps {
  project?: Project;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useProjectSharingLink = (project?: Project) => {
  return useMemo(() => {
    if (!project) {
      return null;
    }

    // map the project.language to the language code
    const languageCode = {
      en: "en-US",
      nl: "nl-NL",
      de: "de-DE",
      fr: "fr-FR",
      es: "es-ES",
      "en-US": "en-US",
      "nl-NL": "nl-NL",
      "de-DE": "de-DE",
      "fr-FR": "fr-FR",
      "es-ES": "es-ES",
    }[
      project.language as
        | "en"
        | "nl"
        | "de"
        | "fr"
        | "es"
        | "en-US"
        | "nl-NL"
        | "de-DE"
        | "fr-FR"
        | "es-ES"
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
        title: `Join the conversation on Dembrane`,
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
