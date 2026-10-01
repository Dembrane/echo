import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const template = {
	"template.not_allowed": msg({
		id: "error.template.not_allowed",
		message:
			"You can use this template, but not change it. Ask a workspace admin if you need to.",
	}),
	"template.not_found": msg({
		id: "error.template.not_found",
		message: "We could not find this template. It may have been deleted.",
	}),
	"template.quick_access_duplicate": msg({
		id: "error.template.quick_access_duplicate",
		message: "This template is already in quick access.",
	}),
	"template.quick_access_not_found": msg({
		id: "error.template.quick_access_not_found",
		message:
			"One of these templates is no longer available. Remove it from quick access and save again.",
	}),
	"template.quick_access_too_many": msg({
		id: "error.template.quick_access_too_many",
		message: "Quick access holds up to {max} templates. Remove one first.",
	}),
	"template.read_only_collaborator": msg({
		id: "error.template.read_only_collaborator",
		message:
			"You can view this workspace, but not add templates to it. Ask a workspace admin for edit access.",
	}),
} satisfies Messages<"template">;
