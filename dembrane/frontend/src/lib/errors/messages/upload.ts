import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const upload = {
	"upload.confirm_failed": msg({
		id: "error.upload.confirm_failed",
		message: "Your file arrived, but we could not save it. Try again.",
	}),
	"upload.empty": msg({
		id: "error.upload.empty",
		message: "This file is empty. Choose another file.",
	}),
	"upload.failed": msg({
		id: "error.upload.failed",
		message: "The upload did not finish. Try again.",
	}),
	"upload.file_not_found": msg({
		id: "error.upload.file_not_found",
		message: "We could not find this file. It may have been removed.",
	}),
	"upload.probe_url_failed": msg({
		id: "error.upload.probe_url_failed",
		message: "We could not check your connection. Try again.",
	}),
	"upload.too_large": msg({
		id: "error.upload.too_large",
		message: "This file is too large. Files can be at most {max_mb} MB.",
	}),
	"upload.transcription_failed": msg({
		id: "error.upload.transcription_failed",
		message: "We could not turn this audio into text. Try again.",
	}),
	"upload.unsupported_type": msg({
		id: "error.upload.unsupported_type",
		message: "This type of file is not supported.",
	}),
	"upload.url_failed": msg({
		id: "error.upload.url_failed",
		message: "We could not start the upload. Try again.",
	}),
} satisfies Messages<"upload">;
