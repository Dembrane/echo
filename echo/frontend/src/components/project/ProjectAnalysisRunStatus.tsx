import { Trans } from "@lingui/react/macro";
import { directus } from "@/lib/directus";
import { readItems } from "@directus/sdk";
import { Alert, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { CloseableAlert } from "../common/ClosableAlert";
import { useLatestProjectAnalysisRunByProjectId } from "./hooks";

export const ProjectAnalysisRunStatus = ({
  projectId,
}: {
  projectId: string;
}) => {
  const latestRunQuery = useLatestProjectAnalysisRunByProjectId(
    projectId ?? "",
  );

  // one off query
  const conversationChunksQuery = useQuery({
    queryKey: ["conversationChunksProcessingPending", projectId],
    queryFn: async () => {
      const projectAnalysisRun = latestRunQuery.data;
      if (!projectAnalysisRun) {
        return 0;
      }

      const data = await directus.request(
        readItems("conversation_chunk", {
          filter: {
            timestamp: {
              // @ts-expect-error _gt is not typed
              _gt: projectAnalysisRun.created_at,
            },
          },
          fields: ["id"],
          limit: 1,
        }),
      );

      if (data.length === 0) {
        return 0;
      }

      try {
        return data.length;
      } catch {
        return 0;
      }
    },
    enabled: !!latestRunQuery.data,
  });

  const data = latestRunQuery.data ?? null;

  if (data == null) {
    return null;
  }

  // if (data.processing_status === "DONE") {
  //   return (
  //     <Stack className="italic text-gray-700">
  //       {!!conversationChunksQuery.data && conversationChunksQuery.data > 0 ? (
  //         <CloseableAlert>
  //           <Trans>
  //             New conversations have been added since the library was generated.
  //             Regenerate the library to process them.
  //           </Trans>
  //         </CloseableAlert>
  //       ) : (
  //         <></>
  //       )}
  //       <div>
  //         <Trans>This project library was generated on</Trans>{" "}
  //         {new Date(data.created_at ?? new Date()).toLocaleString()}.
  //       </div>
  //     </Stack>
  //   );
  // }

  return (
    <div className="italic text-gray-700">
      {conversationChunksQuery.data && conversationChunksQuery.data > 0 ? (
        <CloseableAlert>
          <Trans id="library.new.conversations">
            New conversations have been added since the creation of the library.
            Create a new view to add these to the analysis.
          </Trans>
        </CloseableAlert>
      ) : null}
      {/* {data.processing_status}: {data.processing_message}{" "} */}
    </div>
  );
};
