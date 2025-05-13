import { Button, Stack, Title } from "@mantine/core";
import { toast } from "@/components/common/Toaster";
import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useProjectById, useProjectChats } from "@/lib/query";
import { ENABLE_CHAT_AUTO_SELECT } from "@/config";

export default function DebugPage() {
  const ref = useRef<number>(0);
  const handleTestToast = () => {
    if (ref.current === 0) {
      toast.success("Test toast");
    } else if (ref.current === 1) {
      toast.error("Test toast");
    } else if (ref.current === 2) {
      toast.warning("Test toast");
    } else if (ref.current === 3) {
      toast.info("Test toast");
    } else if (ref.current === 4) {
      toast.error("Test toast");
    } else {
      toast("Test toast");
    }

    ref.current++;
  };

  const { projectId } = useParams();

  const { data: project } = useProjectById({ projectId: projectId! });

  const chatsQuery = useProjectChats(projectId!, {
    filter: {
      project_id: {
        _eq: projectId,
      },
      "count(project_chat_messages)": {
        // @ts-ignore
        _gt: 0,
      },
    },
  });

  const variables = {
    ENABLE_CHAT_AUTO_SELECT,
  };

  return (
    <Stack className="p-8">
      <Stack>
        <Title order={1}>Debug</Title>
        <Stack>
          <Title order={1}>Variables</Title>
          <pre>{JSON.stringify(variables, null, 2)}</pre>
        </Stack>
        <div>
          <Button onClick={handleTestToast}>Test Toast</Button>
        </div>
      </Stack>
      <Stack>
        <Title order={1}>Project</Title>
        <pre>{JSON.stringify(project, null, 2)}</pre>
      </Stack>
      <Stack>
        <Title order={1}>Chats (NE)</Title>
        <pre>{JSON.stringify(chatsQuery.data, null, 2)}</pre>
      </Stack>
    </Stack>
  );
}
