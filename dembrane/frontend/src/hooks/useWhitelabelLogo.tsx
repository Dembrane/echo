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

/**
 * Shows `logoUrl` to everything inside, leaving the app-wide logo alone.
 * For a subtree that knows its logo during render, such as the portal.
 */
export const WhitelabelLogoScope = ({
	logoUrl,
	children,
}: {
	logoUrl: string | null;
	children: ReactNode;
}) => {
	const { setLogoUrl } = useContext(WhitelabelLogoContext);
	return (
		<WhitelabelLogoContext.Provider value={{ logoUrl, setLogoUrl }}>
			{children}
		</WhitelabelLogoContext.Provider>
	);
};

export const useWhitelabelLogo = () => {
	return useContext(WhitelabelLogoContext);
};
