// always throws a error with a message
export function throwWithMessage(e: unknown): never {
	if (
		e &&
		typeof e === "object" &&
		"errors" in e &&
		// biome-ignore lint/suspicious/noExplicitAny: need to address this later
		Array.isArray((e as any).errors)
	) {
		// Handle Directus error format
		// biome-ignore lint/suspicious/noExplicitAny: need to address this later
		const message = (e as any).errors[0].message;
		console.log(message);
		throw new Error(message);
	} else if (e instanceof Error) {
		// Handle generic errors
		console.log(e.message);
		throw new Error(e.message);
	} else {
		// Handle unknown errors
		console.log("An unknown error occurred");
		throw new Error("Something went wrong");
	}
}
