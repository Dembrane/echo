import { createContext, type ReactNode, useContext, useState } from "react";

type WhitelabelLogoContextType = {
	/** `undefined` = not resolved yet, `null` = no custom logo, `string` = custom URL */
	logoUrl: string | null | undefined;
	setLogoUrl: (url: string | null) => void;
};

const WhitelabelLogoContext = createContext<WhitelabelLogoContextType>({
	logoUrl: undefined,
	setLogoUrl: () => {},
});

export const WhitelabelLogoProvider = ({
	children,
}: {
	children: ReactNode;
}) => {
	const [logoUrl, setLogoUrl] = useState<string | null | undefined>(undefined);

	return (
		<WhitelabelLogoContext.Provider value={{ logoUrl, setLogoUrl }}>
			{children}
		</WhitelabelLogoContext.Provider>
	);
};

export const useWhitelabelLogo = () => {
	return useContext(WhitelabelLogoContext);
};
