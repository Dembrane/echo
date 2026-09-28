// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { beforeAll, expect, it } from "vitest";
import type { PresentedError } from "@/lib/errors/present";
import { actionTarget } from "./actions";

const base: PresentedError = {
	action: "none",
	admin: null,
	code: "x.y",
	fields: {},
	message: "m",
	params: {},
	status: 400,
};

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

it("links each action where it should", () => {
	window.history.pushState({}, "", "/o/org-1/projects?tab=a");
	expect(actionTarget({ ...base, action: "upgrade" }, i18n)?.href).toBe(
		"/o/org-1/settings/billing",
	);
	expect(
		actionTarget(
			{ ...base, action: "upgrade", params: { organisation_id: "org-2" } },
			i18n,
		)?.href,
	).toBe("/o/org-2/settings/billing");
	expect(actionTarget({ ...base, action: "sign_in" }, i18n)?.href).toBe(
		`/login?next=${encodeURIComponent("/o/org-1/projects?tab=a")}`,
	);
	expect(actionTarget({ ...base, action: "retry" }, i18n)).toBeNull();
	const retry = () => {};
	expect(
		actionTarget({ ...base, action: "retry" }, i18n, { onRetry: retry })
			?.onClick,
	).toBe(retry);
	expect(actionTarget({ ...base, action: "contact_admin" }, i18n)).toBeNull();
	expect(
		actionTarget(
			{
				...base,
				action: "contact_admin",
				admin: { email: "a@b.c", name: "Ada" },
			},
			i18n,
		),
	).toEqual({ href: "mailto:a@b.c", label: "Email Ada" });
	expect(
		actionTarget({ ...base, action: "contact_support" }, i18n)?.href,
	).toContain("subject=dembrane%3A%20x.y");
	for (const action of ["fix_input", "wait", "none"] as const)
		expect(actionTarget({ ...base, action }, i18n)).toBeNull();
});
