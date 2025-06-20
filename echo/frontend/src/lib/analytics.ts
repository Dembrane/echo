import Plausible from "plausible-tracker";
import { PLAUSIBLE_API_HOST } from "@/config";

// add "trackLocalhost: true" to the Plausible config for local development events
const plausible = Plausible({
  domain: window.location.hostname,
  apiHost: PLAUSIBLE_API_HOST,
});

export const analytics = {
  trackEvent: plausible.trackEvent,
  enableAutoPageviews: plausible.enableAutoPageviews,
};
