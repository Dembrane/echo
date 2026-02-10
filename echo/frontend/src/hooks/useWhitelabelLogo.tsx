import { createContext, type ReactNode, useContext, useState } from "react";

type WhitelabelLogoContextType = {
	logoUrl: string | null;
	setLogoUrl: (url: string | null) => void;
};

const WhitelabelLogoContext = createContext<WhitelabelLogoContextType>({
	logoUrl: null,
	setLogoUrl: () => {},
});

export const WhitelabelLogoProvider = ({
	children,
}: {
	children: ReactNode;
}) => {
	const [logoUrl, setLogoUrl] = useState<string | null>(null);

	return (
		<WhitelabelLogoContext.Provider value={{ logoUrl, setLogoUrl }}>
			{children}
		</WhitelabelLogoContext.Provider>
	);
};

export const useWhitelabelLogo = () => {
	return useContext(WhitelabelLogoContext);
};
