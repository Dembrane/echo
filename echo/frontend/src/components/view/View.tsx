import { Trans } from "@lingui/react/macro";
import { Icons } from "@/icons";
import {
  ActionIcon,
  Group,
  Paper,
  Pill,
  Spoiler,
  Stack,
  Text,
  Modal,
  Tooltip,
} from "@mantine/core";
import { IconArrowsDiagonal, IconRefresh } from "@tabler/icons-react";
import { AspectCard } from "../aspect/AspectCard";
import { useParams } from "react-router";
import { Markdown } from "../common/Markdown";
import { I18nLink } from "../common/i18nLink";
import { useCopyView } from "./hooks/useCopyView";
import { CopyIconButton } from "../common/CopyIconButton";
import { formatRelative } from "date-fns";
import { useDisclosure } from "@mantine/hooks";
import { CreateView } from "./CreateViewForm";

export const ViewCard = ({ data }: { data: View }) => {
  return (
    <Paper bg="white" p="md">
      <Stack gap="sm">
        <Text size="xl">{data.name}</Text>
        <Group>
          <Pill>
            <Group>
              <Text className="font-semibold">
                {data.aspects?.length ?? 0} <Trans>Aspects</Trans>
              </Text>
            </Group>
          </Pill>
        </Group>
      </Stack>
    </Paper>
  );
};

export const ViewExpandedCard = ({ data, isLibraryEnabled }: { data: View; isLibraryEnabled: boolean }) => {
  const { projectId } = useParams();
  const { copyView, copied } = useCopyView();
  const [opened, { open, close }] = useDisclosure(false);

  return (
    <Paper p="md">
      <Stack>
        <Group justify="space-between">
          <Group c="gray">
            <Icons.View />
            <Text className="font-semibold">
              <Trans>View</Trans>
            </Text>
            {data.created_at && (
              <Text size="sm" c="gray">
                {formatRelative(
                  new Date(data.created_at ?? new Date()),
                  new Date(),
                )}
              </Text>
            )}
          </Group>

          <Group>
            <CopyIconButton
              size={24}
              onCopy={() => copyView(data.id)}
              copied={copied}
            />
            {isLibraryEnabled && (
              <Tooltip label={<Trans id="view.recreate.tooltip">Recreate View</Trans>} position="bottom">
                <ActionIcon variant="transparent" c="gray" onClick={open}>
                  <IconRefresh />
                </ActionIcon>
              </Tooltip>
            )}
            <I18nLink to={`/projects/${projectId}/library/views/${data.id}`}>
              <ActionIcon component="a" variant="transparent" c="gray">
                <IconArrowsDiagonal />
              </ActionIcon>
            </I18nLink>
          </Group>
        </Group>

        {/* {data.processing_status !== "DONE" && (
          <Text className="italic text-gray-700">
            {data.processing_status}: {data.processing_message}
          </Text>
        )} */}

        <Text className="text-2xl font-semibold">{data.name}</Text>
        <Group>
          <Pill>
            <Group>
              <Text className="font-semibold">
                {data.aspects?.length ?? 0} <Trans>Aspects</Trans>
              </Text>
            </Group>
          </Pill>
        </Group>
        <Spoiler maxHeight={120} showLabel="Show more" hideLabel="Show less">
          <Markdown content={data.description ?? ""} />
        </Spoiler>

        <div className="flex w-full snap-x overflow-x-auto pb-2">
          {data.aspects?.map((a) => (
            <div className="ml-4 grid snap-start scroll-ml-4" key={a.id}>
              <AspectCard data={a} />
            </div>
          ))}
        </div>
      </Stack>

      <Modal
        opened={opened}
        onClose={close}
        title={
          <Group>
            <Icons.View />
            <Text fw={500} size="lg">
              <Trans id="view.recreate.modal.title">Recreate View</Trans>
            </Text>
          </Group>
        }
        withinPortal
        size="lg"
      >
        <CreateView
          projectId={projectId ?? ""}
          initialQuery={data.user_input ?? ""}
          initialAdditionalContext={data.user_input_description ?? ""}
        />
      </Modal>
    </Paper>
  );
};
