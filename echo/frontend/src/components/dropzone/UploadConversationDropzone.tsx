import { t } from "@lingui/core/macro";
import { useProjectById, useUploadConversation } from "@/lib/query";
import { LoadingOverlay } from "@mantine/core";
import { PropsWithChildren } from "react";
import { CommonDropzone } from "./Dropzone";

export const UploadConversationDropzone = (
  props: PropsWithChildren<{
    projectId: string;
    idle?: React.ReactNode;
    reject?: React.ReactNode;
    accept?: React.ReactNode;
  }>,
) => {
  const uploadConversationMutation = useUploadConversation();

  const projectQuery = useProjectById({
    projectId: props.projectId,
  });

  if (projectQuery.isLoading) {
    return <LoadingOverlay visible />;
  }

  return (
    <CommonDropzone
      onDrop={(files) => {
        uploadConversationMutation.mutate({
          projectId: props.projectId,
          namePrefix: "uploaded-",
          chunks: files,
          pin: projectQuery.data?.pin || "",
          tagIdList: [],
          timestamps: files.map(() => new Date()),
        });
      }}
      maxFiles={10}
      maxSize={200 * 1024 * 1024}
      onReject={(files) => {
        alert(
          t`Something went wrong while uploading the file: ${files[0].errors[0].message}`,
        );
      }}
      loading={uploadConversationMutation.isPending}
      accept={[
        "audio/mp3",
        "audio/wav",
        "audio/mpeg",
        "audio/ogg",
        "audio/webm",
        "video/mp4",
        "audio/webm",
      ]}
    >
      {props.children}
    </CommonDropzone>
  );
};
