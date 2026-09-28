import { ForbiddenError, NotFoundError } from "../src";

// @ts-expect-error unknown code
new NotFoundError("project.nope");
// @ts-expect-error placeholders are required
new ForbiddenError("billing.tier_required");
// @ts-expect-error a placeholder param missing
new ForbiddenError("billing.tier_required", { params: { tier: "free" } });
new ForbiddenError("access.forbidden", { params: { admin_email: "a@b.c" } });
