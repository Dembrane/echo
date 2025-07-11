import { t } from "@lingui/core/macro";
import { useUploadResourceByProjectIdMutation } from "./hooks";
import { PDF_MIME_TYPE } from "@mantine/dropzone";
import { PropsWithChildren } from "react";
import { CommonDropzone } from "./Dropzone";
import { toast } from "../common/Toaster";

export const UploadResourceDropzone = (
  props: PropsWithChildren<{
    projectId: string;
    idle?: React.ReactNode;
    reject?: React.ReactNode;
    accept?: React.ReactNode;
  }>,
) => {
  const uploadDocumentsMutation = useUploadResourceByProjectIdMutation();

  return (
    <CommonDropzone
      onDrop={(files) => {
        uploadDocumentsMutation.mutate({
          projectId: props.projectId,
          files,
        });
      }}
      onReject={(files) => {
        toast.error(
          t`Something went wrong while uploading the file: ${files[0].errors[0].message}`,
        );
      }}
      loading={uploadDocumentsMutation.isPending}
      accept={PDF_MIME_TYPE}
    >
      {props.children}
    </CommonDropzone>
  );
};
