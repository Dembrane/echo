import { QRCode as Q } from "react-qrcode-logo";

import { CURRENT_BRAND } from "./Logo";

/**
 * QRCode component
 * Try to wrap this component in a div with a fixed width and height
 */
export const QRCode = (props: { value: string; ref?: any }) => {
	return (
		<Q
			value={props.value}
			ref={props.ref}
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
};
