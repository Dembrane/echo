import { Outlet } from "react-router";
import { Toaster } from "@/components/common/Toaster";

export const Verify = () => {
	return (
		<>
			<Toaster position="top-center" richColors /> <Outlet />
		</>
	);
};
