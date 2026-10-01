import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const tag = {
	"tag.not_found": msg({
		id: "error.tag.not_found",
		message: "We could not find this tag. It may have been deleted.",
	}),
} satisfies Messages<"tag">;
