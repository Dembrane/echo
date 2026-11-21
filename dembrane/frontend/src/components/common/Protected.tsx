import type { PropsWithChildren } from "react";
import { useAuthenticated } from "@/components/auth/hooks";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { HostIdentitySync } from "@/lib/analytics/HostIdentitySync";

export const Protected = (props: PropsWithChildren) => {
	const { loading, isAuthenticated } = useAuthenticated(true);

	if (loading) {
		return <BeautifulLoading />;
	}

	if (!isAuthenticated) {
		return null;
	}

	return (
		<>
			<HostIdentitySync />
			{props.children}
		</>
	);
};
