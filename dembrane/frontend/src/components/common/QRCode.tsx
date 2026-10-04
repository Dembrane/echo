import { useComputedColorScheme } from "@mantine/core";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { type CSSProperties, type Ref, useState } from "react";
import { QRCode as Q } from "react-qrcode-logo";
import { darkRoles, roles } from "@/colors";

import { CURRENT_BRAND } from "./Logo";

// Phone cameras read a code turned over, as long as the contrast holds and the
// quiet zone carries the colour the modules sit on. Scanners that skip the
// inverted pass do not, which is why only a dark screen asks for this.
const INVERTED_INK = "#F6F4F1";
const INVERTED_FIELD = "#1B1B1A";

interface QRCodeProps {
	value: string;
	href?: string;
	ref?: Ref<HTMLDivElement>;
	className?: string;
	style?: CSSProperties;
	/** Light modules on a dark field, for a screen the room has turned down.
	 * Left out, the code follows the colour scheme (on the page's own black in
	 * dark); pass false for a code that must stay black on white (a download,
	 * an authenticator app). */
	inverted?: boolean;
	/** Names the link for a screen reader; the code itself is an image. */
	"aria-label"?: string;
	"data-testid"?: string;
}

export const QRCode = ({
	value,
	href,
	ref,
	className,
	style,
	inverted,
	"aria-label": ariaLabel,
	"data-testid": dataTestId,
}: QRCodeProps) => {
	const [hovered, setHovered] = useState(false);
	const dark = useComputedColorScheme("light") === "dark";
	const isInverted = inverted ?? dark;
	const field = isInverted
		? inverted === undefined
			? darkRoles.bg
			: INVERTED_FIELD
		: "#FFFFFF";

	const qrElement = (
		<Q
			value={value}
			logoImage={
				CURRENT_BRAND === "dembrane"
					? isInverted
						? "/dembrane-logomark-cropped-dark.png"
						: "/dembrane-logomark-cropped.png"
					: "/aiconl-logo-hq.png"
			}
			logoWidth={200}
			logoHeight={200}
			fgColor={isInverted ? INVERTED_INK : "#000000"}
			bgColor={field}
			eyeColor={isInverted ? INVERTED_INK : "#000000"}
			logoPadding={16}
			removeQrCodeBehindLogo
			logoPaddingStyle="circle"
			size={1024}
			style={{
				height: "100%",
				width: "100%",
			}}
		/>
	);

	if (!href) {
		return (
			<div
				ref={ref}
				className={className}
				style={style}
				data-testid={dataTestId}
			>
				{qrElement}
			</div>
		);
	}

	return (
		<a
			ref={ref as Ref<HTMLAnchorElement>}
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={ariaLabel}
			className={`relative block cursor-pointer overflow-hidden transition-all ${className ?? ""}`}
			style={{ backgroundColor: field, ...style }}
			data-testid={dataTestId}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{qrElement}
			<div
				className="absolute inset-0 flex items-center justify-center transition-all print:hidden"
				style={{
					backgroundColor: hovered
						? `color-mix(in srgb, ${roles.action} 85%, transparent)`
						: "transparent",
					opacity: hovered ? 1 : 0,
				}}
			>
				<ArrowSquareOutIcon size={32} color="white" />
			</div>
		</a>
	);
};
