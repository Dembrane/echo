import { Group } from "@mantine/core";
import {
	type FileRejection,
	Dropzone as MantineDropzone,
} from "@mantine/dropzone";
import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import type { PropsWithChildren, ReactNode } from "react";

interface CommonDropzoneProps {
	idle?: ReactNode;
	reject?: ReactNode;
	accept?: ReactNode;
	maxFiles?: number;
	maxSize?: number;
	loading?: boolean;
	onDrop: (files: File[]) => void;
	onReject: (fileRejections: FileRejection[]) => void;
}

export const CommonDropzone = ({
	idle,
	reject,
	accept,
	children,
	...props
}: PropsWithChildren<CommonDropzoneProps>) => {
	return (
		<MantineDropzone p="sm" {...props}>
			<Group justify="center" gap="xl" style={{ pointerEvents: "none" }}>
				<MantineDropzone.Accept>
					{accept || (
						<UploadSimpleIcon
							size={20}
							color="var(--mantine-color-primary-7)"
						/>
					)}
				</MantineDropzone.Accept>
				<MantineDropzone.Reject>
					{reject || <XIcon size={20} color="var(--mantine-color-red-7)" />}
				</MantineDropzone.Reject>
				<MantineDropzone.Idle>{idle || children}</MantineDropzone.Idle>
			</Group>
		</MantineDropzone>
	);
};
