import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Slider, Stack, Text } from "@mantine/core";
import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";

type ImageCropModalProps = {
	opened: boolean;
	onClose: () => void;
	imageSrc: string;
	onCropComplete: (croppedBlob: Blob) => void;
	aspect?: number;
	cropShape?: "rect" | "round";
	title?: string;
};

async function getCroppedImg(
	imageSrc: string,
	pixelCrop: Area,
): Promise<Blob> {
	const image = new Image();
	image.crossOrigin = "anonymous";

	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = reject;
		image.src = imageSrc;
	});

	const canvas = document.createElement("canvas");
	canvas.width = pixelCrop.width;
	canvas.height = pixelCrop.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not get canvas context");

	ctx.drawImage(
		image,
		pixelCrop.x,
		pixelCrop.y,
		pixelCrop.width,
		pixelCrop.height,
		0,
		0,
		pixelCrop.width,
		pixelCrop.height,
	);

	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Canvas toBlob failed"));
			},
			"image/png",
			1,
		);
	});
}

export const ImageCropModal = ({
	opened,
	onClose,
	imageSrc,
	onCropComplete,
	aspect = 1,
	cropShape = "rect",
	title,
}: ImageCropModalProps) => {
	const [crop, setCrop] = useState({ x: 0, y: 0 });
	const [zoom, setZoom] = useState(1);
	const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(
		null,
	);

	const onCropCompleteCallback = useCallback(
		(_croppedArea: Area, croppedAreaPixels: Area) => {
			setCroppedAreaPixels(croppedAreaPixels);
		},
		[],
	);

	const handleSave = async () => {
		if (!croppedAreaPixels) return;
		const croppedBlob = await getCroppedImg(imageSrc, croppedAreaPixels);
		onCropComplete(croppedBlob);
		onClose();
	};

	const handleReset = () => {
		setCrop({ x: 0, y: 0 });
		setZoom(1);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Text fw={600} size="lg">
					{title ?? t`Crop Image`}
				</Text>
			}
			size="md"
			onExitTransitionEnd={handleReset}
		>
			<Stack gap="md">
				<div
					style={{
						position: "relative",
						width: "100%",
						height: 350,
						background: "#333",
						borderRadius: 8,
						overflow: "hidden",
					}}
				>
					<Cropper
						image={imageSrc}
						crop={crop}
						zoom={zoom}
						aspect={aspect}
						cropShape={cropShape}
						onCropChange={setCrop}
						onZoomChange={setZoom}
						onCropComplete={onCropCompleteCallback}
					/>
				</div>

				<Stack gap={4}>
					<Text size="sm" fw={500}>
						<Trans>Zoom</Trans>
					</Text>
					<Slider
						value={zoom}
						onChange={setZoom}
						min={1}
						max={3}
						step={0.1}
						label={(v) => `${Math.round(v * 100)}%`}
					/>
				</Stack>

				<Group justify="flex-end" gap="sm">
					<Button variant="default" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button onClick={handleSave}>
						<Trans>Apply</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
