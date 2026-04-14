import { rem } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { type CSSProperties, type Ref, useState } from "react";
import { QRCode as Q } from "react-qrcode-logo";

import { CURRENT_BRAND } from "./Logo";

interface QRCodeProps {
	value: string;
	href?: string;
	ref?: Ref<HTMLDivElement>;
	className?: string;
	style?: CSSProperties;
	"data-testid"?: string;
}

export const QRCode = ({
	value,
	href,
	ref,
	className,
	style,
	"data-testid": dataTestId,
}: QRCodeProps) => {
	const [hovered, setHovered] = useState(false);

	const qrElement = (
		<Q
			value={value}
			logoImage={
				CURRENT_BRAND === "dembrane"
					? "/dembrane-logomark-cropped.png"
					: "/aiconl-logo-hq.png"
			}
			logoWidth={200}
			logoHeight={200}
			eyeColor={"#000000"}
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
			<div ref={ref} className={className} style={style} data-testid={dataTestId}>
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
			className={`relative block cursor-pointer overflow-hidden rounded-lg bg-white transition-all ${className ?? ""}`}
			style={style}
			data-testid={dataTestId}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{qrElement}
			<div
				className="absolute inset-0 flex items-center justify-center rounded-lg transition-all print:hidden"
				style={{
					backgroundColor: hovered
						? "rgba(65, 105, 225, 0.85)"
						: "transparent",
					opacity: hovered ? 1 : 0,
				}}
			>
				<IconExternalLink
					style={{ height: rem(32), width: rem(32) }}
					color="white"
				/>
			</div>
		</a>
	);
};
