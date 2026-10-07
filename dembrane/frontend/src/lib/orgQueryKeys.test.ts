import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { invalidateOrgMembersEverywhere } from "./orgQueryKeys";

it("a member change also refreshes the organisation header's people count", async () => {
	const qc = new QueryClient();
	const header = ["v2", "organisation", "o1"];
	qc.setQueryData(header, { member_count: 4 });
	qc.setQueryData(["v2", "organisation", "o1", "members"], []);
	invalidateOrgMembersEverywhere(qc, "o1");
	expect(qc.getQueryState(header)?.isInvalidated).toBe(true);
	// Other organisations are left alone.
	qc.setQueryData(["v2", "organisation", "o2"], { member_count: 1 });
	invalidateOrgMembersEverywhere(qc, "o1");
	expect(qc.getQueryState(["v2", "organisation", "o2"])?.isInvalidated).toBe(
		false,
	);
});
