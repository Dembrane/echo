import { createBrowserRouter } from "react-router";
import { participantRoutes } from "./portal/routes";

// The portal's router stays in the entry so participants wait on no extra
// request. The dashboard's routes (with their eagerly imported layouts) load as
// their own chunk, which keeps them out of the portal's first load.
export const participantRouter = createBrowserRouter(participantRoutes);

export const loadMainRouter = () =>
	import("./DashboardRouter").then((m) => m.mainRouter);
