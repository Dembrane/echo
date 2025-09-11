import { Paper, Stack, Text } from "@mantine/core";
import { Link, useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

export const Insight = ({
  data,
  overrideProjectId,
}: {
  data: Insight;
  // use this to override the project id
  overrideProjectId?: string;
}) => {
  let { projectId } = useParams();

  if (overrideProjectId) {
    projectId = overrideProjectId;
  }

  return (
    <I18nLink to={`/projects/${projectId}/library/insights/${data.id}`}>
      <Paper
        component="a"
        className="h-full place-content-start border-2 p-4 text-left transition-all hover:border-primary-300 hover:border-opacity-70"
        withBorder
      >
        <Stack className="h-full">
          <Text size="md" className="font-semibold">
            {data.title}
          </Text>
          <Text size="sm">{data.summary}</Text>
        </Stack>
      </Paper>
    </I18nLink>
  );
};
