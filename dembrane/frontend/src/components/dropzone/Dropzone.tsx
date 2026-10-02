import { Group, rem } from "@mantine/core";
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
							style={{
								color: "var(--mantine-color-blue-6)",
								height: rem(52),
								width: rem(52),
							}}
						/>
					)}
				</MantineDropzone.Accept>
				<MantineDropzone.Reject>
					{reject || (
						<XIcon
							style={{
								color: "var(--mantine-color-red-6)",
								height: rem(52),
								width: rem(52),
							}}
						/>
					)}
				</MantineDropzone.Reject>
				<MantineDropzone.Idle>{idle || children}</MantineDropzone.Idle>
			</Group>
		</MantineDropzone>
	);
};
