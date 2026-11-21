import { describe, expect, it } from "vitest";
import { postOnboardingPath } from "./landing";

const selfServe = {
	createdWorkspaceId: "w1",
	hasLegacyProjects: false,
	isInvited: false,
	startedWithInvites: false,
};

describe("where onboarding ends", () => {
	it("sends a new self-serve host to the template picker in their workspace", () => {
		expect(postOnboardingPath(selfServe)).toBe("/w/w1/projects/new");
	});

	it.each([
		["joined through pending invites", { startedWithInvites: true }],
		["invited before signing up", { isInvited: true }],
	])("keeps today's landing for someone %s", (_, change) => {
		expect(postOnboardingPath({ ...selfServe, ...change })).toBe("/o");
	});

	it("does not redirect a returning host (the org step did not run)", () => {
		expect(postOnboardingPath({ ...selfServe, createdWorkspaceId: null })).toBe(
			"/o",
		);
	});

	it("does not redirect a host who already has projects", () => {
		expect(postOnboardingPath({ ...selfServe, hasLegacyProjects: true })).toBe(
			"/o",
		);
	});
});
