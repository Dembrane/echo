import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

import { PostHogProvider } from "@posthog/react";
import posthog from "posthog-js";
import {
	POSTHOG_CAPTURE,
	POSTHOG_HOST,
	POSTHOG_TOKEN,
	POSTHOG_UI_HOST,
} from "./config";

posthog.init(POSTHOG_TOKEN, {
	api_host: POSTHOG_HOST,
	// api_host is our reverse proxy; ui_host must stay the real PostHog host so
	// the toolbar and in-app links resolve (required when api_host is proxied).
	ui_host: POSTHOG_UI_HOST,
	// Share the cookie across .dembrane.com so a visitor's distinct id carries
	// over from the marketing site, stitching both into one person profile.
	cross_subdomain_cookie: true,
	// Error tracking: autocapture unhandled errors and promise rejections.
	// React render errors are reported separately via ErrorBoundary.
	capture_exceptions: {
		capture_console_errors: false,
		capture_unhandled_errors: true,
		capture_unhandled_rejections: true,
	},
	defaults: "2026-01-30",
	loaded: (ph) => {
		// testing + local never send analytics (see POSTHOG_CAPTURE in config.ts).
		// The opt-out persists per-domain, so explicitly opt back in when the
		// config says capture: otherwise flipping an environment to capture-on
		// would silently keep returning visitors opted out.
		if (!POSTHOG_CAPTURE) {
			ph.opt_out_capturing();
		} else if (ph.has_opted_out_capturing()) {
			// Use the singleton: the `loaded` param is typed without the
			// options bag, and we don't want a $opt_in event in the data.
			posthog.opt_in_capturing({ captureEventName: null });
		}
	},
});

const root = document.getElementById("root");

if (root === null) {
	throw new Error("Root element not found");
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<PostHogProvider client={posthog}>
			<App />
		</PostHogProvider>
	</React.StrictMode>,
);
