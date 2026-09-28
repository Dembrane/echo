import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const memory = {
	"memory.content_required": msg({
		id: "error.memory.content_required",
		message: "Write something for the memory to keep.",
	}),
	"memory.invalid_scope": msg({
		id: "error.memory.invalid_scope",
		message: "Pick who this memory is for from the list.",
	}),
	"memory.not_found": msg({
		id: "error.memory.not_found",
		message: "We could not find this memory. It may have been deleted.",
	}),
} satisfies Messages<"memory">;
