/// <reference types="vite/client" />

declare module "*.woff2?inline" {
	const src: string;
	export default src;
}

declare module "qrcode-generator" {
	type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";
	type QrCode = {
		addData(data: string): void;
		make(): void;
		createSvgTag(cellSize?: number, margin?: number): string;
	};
	export default function qrcode(
		typeNumber: number,
		errorCorrectionLevel: ErrorCorrectionLevel,
	): QrCode;
}
