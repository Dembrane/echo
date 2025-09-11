import { useParams } from "react-router";
import {
  useUpdateProjectReportMutation,
  useGetProjectParticipants,
  useDoesProjectReportNeedUpdate,
  useProjectReportViews,
  useLatestProjectReport,
} from "@/components/report/hooks";
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Skeleton,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
  Modal,
} from "@mantine/core";
import { AnimatePresence } from "motion/react";
import { CreateReportForm } from "@/components/report/CreateReportForm";
import { Trans } from "@lingui/react/macro";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { IconPrinter, IconSettings, IconShare2 } from "@tabler/icons-react";
import { Icons } from "@/icons";
import { t } from "@lingui/core/macro";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { PARTICIPANT_BASE_URL } from "@/config";
import { ProjectQRCode } from "@/components/project/ProjectQRCode";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { ReportTimeline } from "@/components/report/ReportTimeline";
import { useDisclosure } from "@mantine/hooks";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { UpdateReportModalButton } from "@/components/report/UpdateReportModalButton";
import { useState } from "react";

export const ReportLayout = ({
  children,
  rightSection,
}: {
  children: React.ReactNode;
  rightSection?: React.ReactNode;
}) => {
  const { projectId, language } = useParams();

  return (
    <Stack
      gap="3rem"
      px={{ base: "1rem", md: "2rem" }}
      py={{ base: "2rem", md: "4rem" }}
    >
      <Group justify="space-between">
        <Breadcrumbs
          items={[
            {
              label: (
                <Group>
                  <Title order={1}>
                    <Trans>Report</Trans>
                  </Title>
                  <Badge>
                    <Trans>Experimental</Trans>
                  </Badge>
                </Group>
              ),
            },
          ]}
        />
        {rightSection}
      </Group>
      {children}
    </Stack>
  );
};

const ProjectReportAnalytics = ({ reportId }: { reportId: number }) => {
  const { data: views } = useProjectReportViews(reportId);

  const [opened, { toggle }] = useDisclosure();

  return (
    <Stack gap="1.5rem">
      <Group>
        <Title order={4}>Analytics</Title>
        <ActionIcon onClick={toggle} variant="transparent" color="gray.9">
          <IconSettings />
        </ActionIcon>
      </Group>
      <Stack gap="1rem">
        <Text>
          <Trans>This report was opened by {views?.total ?? 0} people</Trans>
        </Text>
        <ReportTimeline reportId={String(reportId)} showBrush={opened} />
      </Stack>
    </Stack>
  );
};

export const ProjectReportRoute = () => {
  const { projectId, language } = useParams();
  const { data, isLoading } = useLatestProjectReport(projectId ?? "");
  const { data: views } = useProjectReportViews(data?.id ?? -1);
  const { mutate: updateProjectReport, isPending: isUpdatingReport } =
    useUpdateProjectReportMutation();
  const [modalOpened, { open, close }] = useDisclosure(false);
  const [publishStatus, setPublishStatus] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const { data: participantCount } = useGetProjectParticipants(projectId ?? "");
  const handleConfirmPublish = () => {
    if (!data?.id) return;
    updateProjectReport({
      reportId: data.id,
      payload: {
        status: publishStatus ? "published" : "archived",
        project_id: { id: data.project_id } as Project,
      },
    });
    close();
  };

  const contributionLink = `${PARTICIPANT_BASE_URL}/${language}/${projectId}/start`;
  const getSharingLink = (data: ProjectReport) =>
    `${PARTICIPANT_BASE_URL}/${language}/${data.project_id}/report`;

  const { copy, copied } = useCopyToRichText();
  const [parent] = useAutoAnimate();

  if (isLoading) {
    return (
      <ReportLayout>
        <Divider />
        <Skeleton height="100px" />
        <Skeleton height="200px" />
      </ReportLayout>
    );
  }

  if (!data) {
    return (
      <ReportLayout>
        <Divider />
        <CreateReportForm onSuccess={() => {}} />
      </ReportLayout>
    );
  }

  if (data.status === "error") {
    return (
      <ReportLayout>
        <Title order={2}>
          <Trans>
            Report generation is currently in beta and limited to projects with
            fewer than 10 hours of recording.
          </Trans>
        </Title>

        <Text>
          <Trans>
            There was an error generating your report. In the meantime, you can
            analyze all your data using the library or select specific
            conversations to chat with.
          </Trans>
        </Text>
      </ReportLayout>
    );
  }

  return (
    <ReportLayout
      rightSection={
        <Group>
          <AnimatePresence>
            {data.status === "published" && (
              <Group>
                <UpdateReportModalButton reportId={data.id} />

                <Tooltip label={t`Share this report`}>
                  <ActionIcon
                    onClick={() => {
                      const url = getSharingLink(data);
                      if (navigator.canShare({ url })) {
                        navigator.share({ url });
                      } else {
                        window.open(url, "_blank");
                      }
                    }}
                    variant="transparent"
                    color="gray.9"
                    size={24}
                    className="lg:hidden"
                  >
                    <IconShare2 />
                  </ActionIcon>
                </Tooltip>

                <CopyIconButton
                  onCopy={() => {
                    copy(getSharingLink(data));
                  }}
                  copyTooltip={t`Copy link to share this report`}
                  copied={copied}
                  variant="transparent"
                  color="gray.9"
                  size={20}
                />

                <Tooltip label={t`Print this report`}>
                  <ActionIcon
                    onClick={() => {
                      window.open(
                        getSharingLink(data) + "?print=true",
                        "_blank",
                      );
                    }}
                    variant="transparent"
                    color="gray.9"
                    size={24}
                  >
                    <IconPrinter />
                  </ActionIcon>
                </Tooltip>

                <Divider orientation="vertical" />
              </Group>
            )}
          </AnimatePresence>
          <Switch
            label={data.status === "published" ? t`Published` : t`Publish`}
            checked={data.status === "published"}
            size={data.status === "published" ? "md" : "sm"}
            onChange={(e) => {
              const isPublishing = e.target.checked;
              const participantsToNotify = participantCount ?? 0;

              if (isPublishing) {
                if (participantsToNotify > 0) {
                  setPublishStatus(true);
                  open();
                } else {
                  updateProjectReport({
                    reportId: data.id,
                    payload: {
                      status: "published",
                      project_id: { id: data.project_id } as Project,
                    },
                  });
                }
              } else {
                updateProjectReport({
                  reportId: data.id,
                  payload: {
                    status: "archived",
                    project_id: { id: data.project_id } as Project,
                  },
                });
              }
            }}
            disabled={isUpdatingReport}
          />
        </Group>
      }
    >
      <Divider />
      <Stack gap="3rem">
        <ProjectReportAnalytics reportId={data.id} />

        <Stack gap="1.5rem">
          <Title order={4}>Settings</Title>
          <Stack gap="1rem">
            <Checkbox
              label={t`Include portal link in report`}
              checked={data.show_portal_link ?? true}
              onChange={(e) => {
                updateProjectReport({
                  reportId: data.id,
                  payload: {
                    show_portal_link: e.target.checked ? true : false,
                    project_id: { id: data.project_id } as Project,
                  },
                });
              }}
              disabled={isUpdatingReport}
            />
            <Checkbox
              label={t`Show timeline in report (request feature)`}
              checked={false}
              disabled
            />
            <Checkbox
              label={t`Password protect portal (request feature)`}
              checked={false}
              disabled
            />
          </Stack>
        </Stack>

        <Divider />
        <div className="flex justify-end">
          <Switch
            label={t`Editing mode`}
            checked={isEditing}
            onChange={() => setIsEditing(!isEditing)}
            size="md"
          />
        </div>
        <ReportRenderer
          reportId={data.id}
          isEditing={isEditing}
          opts={{
            showBorder: true,
            contributeLink: data.show_portal_link
              ? contributionLink
              : undefined,
            readingNow: views?.recent ?? 0,
          }}
        />
        <Modal
          opened={modalOpened}
          onClose={close}
          title={t`Confirm Publishing`}
        >
          <Text size="sm">
            <Trans>
              An email notification will be sent to{" "}
              {participantCount !== undefined
                ? participantCount
                : t`loading...`}{" "}
              participant{participantCount == 1 ? "" : "s"}. Do you want to
              proceed?
            </Trans>
          </Text>
          <Group mt="md" justify="end">
            <Button onClick={close} variant="outline">
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={handleConfirmPublish} color="blue">
              <Trans>Proceed</Trans>
            </Button>
          </Group>
        </Modal>
      </Stack>
    </ReportLayout>
  );
};
