import { expect, it } from "vitest";
import { orgPeopleCount } from "./OrganisationRoute";

it("the header counts the same people as the People section: members and externals", () => {
	expect(orgPeopleCount({ external_count: 1, member_count: 4 })).toBe(5);
	expect(orgPeopleCount({ external_count: 0, member_count: 4 })).toBe(4);
});
