import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

import { PostHogProvider } from "@posthog/react";
import posthog from "posthog-js";
import { POSTHOG_CAPTURE, POSTHOG_HOST, POSTHOG_TOKEN } from "./config";

posthog.init(POSTHOG_TOKEN, {
	api_host: POSTHOG_HOST,
	// Error tracking: autocapture unhandled errors and promise rejections.
	// React render errors are reported separately via ErrorBoundary.
	capture_exceptions: {
		capture_console_errors: false,
		capture_unhandled_errors: true,
		capture_unhandled_rejections: true,
	},
	defaults: "2026-01-30",
	loaded: (ph) => {
		// testing + local never send analytics (see POSTHOG_CAPTURE in config.ts)
		if (!POSTHOG_CAPTURE) ph.opt_out_capturing();
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
