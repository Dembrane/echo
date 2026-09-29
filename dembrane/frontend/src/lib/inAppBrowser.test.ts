import { describe, expect, it } from "vitest";
import { detectInAppBrowser } from "./inAppBrowser";

const LINKEDIN_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1230";
const INSTAGRAM_ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0.0 Android";
const FACEBOOK_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0]";
const SAFARI_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

describe("detectInAppBrowser", () => {
	it("recognises the LinkedIn, Instagram and Facebook browsers", () => {
		expect(detectInAppBrowser(LINKEDIN_IOS)).toEqual({
			app: "linkedin",
			os: "ios",
		});
		expect(detectInAppBrowser(INSTAGRAM_ANDROID)).toEqual({
			app: "instagram",
			os: "android",
		});
		expect(detectInAppBrowser(FACEBOOK_IOS)).toEqual({
			app: "facebook",
			os: "ios",
		});
	});

	it("leaves real browsers alone", () => {
		expect(detectInAppBrowser(SAFARI_IOS)).toBeNull();
		expect(detectInAppBrowser(CHROME_ANDROID)).toBeNull();
		expect(detectInAppBrowser("")).toBeNull();
	});
});
