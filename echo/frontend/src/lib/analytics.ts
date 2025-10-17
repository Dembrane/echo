import Plausible from "plausible-tracker";
import { PLAUSIBLE_API_HOST } from "@/config";

// add "trackLocalhost: true" to the Plausible config for local development events
const plausible = Plausible({
	apiHost: PLAUSIBLE_API_HOST,
	domain: window.location.hostname,
});

export const analytics = {
	enableAutoPageviews: plausible.enableAutoPageviews,
	trackEvent: plausible.trackEvent,
};
