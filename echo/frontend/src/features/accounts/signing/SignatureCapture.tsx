import "@fontsource/dancing-script/400.css";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	FileButton,
	Group,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";
import type { SignRequestT } from "../contract/contract.gen";

export type SignatureMethod = SignRequestT["signature"]["method"];

export interface CapturedImage {
	png_base64: string;
	method: SignatureMethod;
	/** For showing it on the page. */
	dataUrl: string;
}

const SCRIPT_FONT = '"Dancing Script", cursive';
const MAX_W = 600;
const MAX_H = 200;

const toCaptured = (
	canvas: HTMLCanvasElement,
	method: SignatureMethod,
): CapturedImage => {
	const dataUrl = canvas.toDataURL("image/png");
	return {
		dataUrl,
		method,
		png_base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
	};
};

/** Crops transparent margins so the image fills its field on the page. */
const trimmed = (source: HTMLCanvasElement): HTMLCanvasElement => {
	const ctx = source.getContext("2d");
	if (!ctx) return source;
	const { width, height } = source;
	const data = ctx.getImageData(0, 0, width, height).data;
	let top = height;
	let left = width;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
				if (x < left) left = x;
				if (x > right) right = x;
				if (y < top) top = y;
				if (y > bottom) bottom = y;
			}
		}
	}
	if (right < 0) return source;
	const pad = 6;
	const out = document.createElement("canvas");
	out.width = right - left + 1 + pad * 2;
	out.height = bottom - top + 1 + pad * 2;
	out
		.getContext("2d")
		?.drawImage(
			source,
			left - pad,
			top - pad,
			out.width,
			out.height,
			0,
			0,
			out.width,
			out.height,
		);
	return out;
};

async function typedImage(text: string): Promise<HTMLCanvasElement> {
	await document.fonts.load(`64px ${SCRIPT_FONT}`);
	const canvas = document.createElement("canvas");
	canvas.width = MAX_W * 2;
	canvas.height = MAX_H;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		let size = 96;
		ctx.font = `${size}px ${SCRIPT_FONT}`;
		while (ctx.measureText(text).width > canvas.width - 40 && size > 24) {
			size -= 4;
			ctx.font = `${size}px ${SCRIPT_FONT}`;
		}
		ctx.fillStyle = "#1c2a4a";
		ctx.textBaseline = "middle";
		ctx.fillText(text, 20, canvas.height / 2);
	}
	return trimmed(canvas);
}

async function uploadedImage(file: File): Promise<HTMLCanvasElement> {
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		// Scaled down so the PNG stays well under the 512 KB the sign request allows.
		const scale = Math.min(
			1,
			MAX_W / img.naturalWidth,
			MAX_H / img.naturalHeight,
		);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
		canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Draw, type or upload a signature. Draw is the default because most people sign on a
 * phone; typed uses a script face; an upload is scaled down and kept as a PNG.
 */
export function SignatureCapture({
	suggestedText,
	onCapture,
	purpose,
}: {
	suggestedText: string;
	onCapture: (image: CapturedImage) => void;
	purpose: "signature" | "initials";
}) {
	const [mode, setMode] = useState<"draw" | "type" | "upload">("draw");
	const [typed, setTyped] = useState(
		purpose === "initials"
			? suggestedText
					.split(/\s+/)
					.map((w) => w[0] ?? "")
					.join("")
					.toUpperCase()
			: suggestedText,
	);
	const [drawn, setDrawn] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const padRef = useRef<SignaturePad | null>(null);

	useEffect(() => {
		if (mode !== "draw") return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ratio = Math.max(window.devicePixelRatio || 1, 1);
		// Resizing a canvas wipes it; the strokes are redrawn so turning a phone keeps them.
		const size = () => {
			const strokes = padRef.current?.toData() ?? [];
			canvas.width = canvas.offsetWidth * ratio;
			canvas.height = canvas.offsetHeight * ratio;
			canvas.getContext("2d")?.scale(ratio, ratio);
			padRef.current?.fromData(strokes);
			setDrawn(strokes.length > 0);
		};
		const pad = new SignaturePad(canvas, {
			maxWidth: 2.6,
			minWidth: 0.8,
			penColor: "#1c2a4a",
		});
		padRef.current = pad;
		size();
		const onEnd = () => setDrawn(!pad.isEmpty());
		pad.addEventListener("endStroke", onEnd);
		window.addEventListener("resize", size);
		return () => {
			pad.removeEventListener("endStroke", onEnd);
			pad.off();
			window.removeEventListener("resize", size);
			padRef.current = null;
		};
	}, [mode]);

	const applyDrawn = () => {
		const canvas = canvasRef.current;
		if (!canvas || !padRef.current || padRef.current.isEmpty()) return;
		onCapture(toCaptured(trimmed(canvas), "drawn"));
	};

	const applyTyped = async () => {
		if (!typed.trim()) return;
		onCapture(toCaptured(await typedImage(typed.trim()), "typed"));
	};

	const applyUpload = async (file: File | null) => {
		if (!file) return;
		setError(null);
		try {
			onCapture(toCaptured(await uploadedImage(file), "uploaded"));
		} catch {
			setError(t`That image could not be read. Try a PNG or JPEG.`);
		}
	};

	return (
		<Stack gap="xs">
			<SegmentedControl
				value={mode}
				onChange={(v) => setMode(v as typeof mode)}
				fullWidth
				size="xs"
				data={[
					{ label: t`Draw`, value: "draw" },
					{ label: t`Type`, value: "type" },
					{ label: t`Upload`, value: "upload" },
				]}
			/>
			{mode === "draw" && (
				<>
					<Box
						style={{
							background: "white",
							border: "1px dashed var(--mantine-color-gray-5)",
							borderRadius: 6,
							touchAction: "none",
						}}
					>
						<canvas
							ref={canvasRef}
							aria-label={
								purpose === "initials"
									? t`Draw your initials`
									: t`Draw your signature`
							}
							data-testid="signature-pad"
							style={{ display: "block", height: 150, width: "100%" }}
						/>
					</Box>
					<Group justify="space-between">
						<Button
							variant="subtle"
							size="xs"
							disabled={!drawn}
							onClick={() => {
								padRef.current?.clear();
								setDrawn(false);
							}}
						>
							<Trans>Clear</Trans>
						</Button>
						<Button size="sm" disabled={!drawn} onClick={applyDrawn}>
							<Trans>Use this</Trans>
						</Button>
					</Group>
				</>
			)}
			{mode === "type" && (
				<>
					<TextInput
						label={purpose === "initials" ? t`Your initials` : t`Your name`}
						value={typed}
						onChange={(e) => setTyped(e.currentTarget.value)}
					/>
					<Box
						px="sm"
						py={4}
						style={{
							background: "white",
							border: "1px dashed var(--mantine-color-gray-5)",
							borderRadius: 6,
							color: "#1c2a4a",
							fontFamily: SCRIPT_FONT,
							fontSize: 40,
							minHeight: 72,
							overflow: "hidden",
							whiteSpace: "nowrap",
						}}
					>
						{typed}
					</Box>
					<Group justify="flex-end">
						<Button size="sm" disabled={!typed.trim()} onClick={applyTyped}>
							<Trans>Use this</Trans>
						</Button>
					</Group>
				</>
			)}
			{mode === "upload" && (
				<Stack gap={6}>
					<Text size="sm" c="dimmed">
						<Trans>A photo or scan of your signature, PNG or JPEG.</Trans>
					</Text>
					<FileButton onChange={applyUpload} accept="image/png,image/jpeg">
						{(props) => (
							<Button variant="default" {...props}>
								<Trans>Choose an image</Trans>
							</Button>
						)}
					</FileButton>
					{error && (
						<Text size="sm" c="red">
							{error}
						</Text>
					)}
				</Stack>
			)}
		</Stack>
	);
}
