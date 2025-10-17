import { t } from "@lingui/core/macro";
import { useDocumentTitle } from "@mantine/hooks";
import { Outlet } from "react-router";

export const ProjectLibraryLayout = () => {
	useDocumentTitle(t`Project Library | Dembrane`);
	return <Outlet />;
};
