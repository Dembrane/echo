import { Group } from "@mantine/core";
import {
	type DropzoneProps,
	type FileRejection,
	Dropzone as MantineDropzone,
} from "@mantine/dropzone";
import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import type { PropsWithChildren, ReactNode } from "react";

interface CommonDropzoneProps {
	idle?: ReactNode;
	reject?: ReactNode;
	/** Shown while a drag holds only accepted files. */
	acceptContent?: ReactNode;
	/**
	 * Which files the drop zone takes: MIME types, each with the extensions that count as
	 * it (`{ "audio/mpeg": [".mp3"] }`). A file is taken when its type or its extension
	 * is listed; anything else goes to onReject with "file-invalid-type". The file dialog
	 * offers only these.
	 */
	accept?: DropzoneProps["accept"];
	maxFiles?: number;
	maxSize?: number;
	loading?: boolean;
	onDrop: (files: File[]) => void;
	onReject: (fileRejections: FileRejection[]) => void;
}

export const CommonDropzone = ({
	idle,
	reject,
	acceptContent,
	children,
	...props
}: PropsWithChildren<CommonDropzoneProps>) => {
	return (
		<MantineDropzone p="sm" {...props}>
			<Group justify="center" gap="xl" style={{ pointerEvents: "none" }}>
				<MantineDropzone.Accept>
					{acceptContent || (
						<UploadSimpleIcon size={20} color="var(--app-action)" />
					)}
				</MantineDropzone.Accept>
				<MantineDropzone.Reject>
					{reject || <XIcon size={20} color="var(--app-danger)" />}
				</MantineDropzone.Reject>
				<MantineDropzone.Idle>{idle || children}</MantineDropzone.Idle>
			</Group>
		</MantineDropzone>
	);
};
