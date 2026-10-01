// Social apps open links in their own browser, which blocks or hides the microphone:
// on production 8 of 9 LinkedIn in-app visitors were blocked and none recorded.

export type InAppBrowser = {
	app: "linkedin" | "instagram" | "facebook";
	os: "ios" | "android" | "other";
};

export const detectInAppBrowser = (ua: string): InAppBrowser | null => {
	const app = /LinkedInApp/i.test(ua)
		? "linkedin"
		: /Instagram/i.test(ua)
			? "instagram"
			: /FBAN|FBAV|FB_IAB/i.test(ua)
				? "facebook"
				: null;
	if (!app) return null;
	const os = /iPhone|iPad|iPod/i.test(ua)
		? "ios"
		: /Android/i.test(ua)
			? "android"
			: "other";
	return { app, os };
};
