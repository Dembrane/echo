/** Portal mode resolution shared by the initiate form; text conversations never
 * count toward the concurrent recording meter. */

export const resolvePortalMode = (
	searchParams: URLSearchParams,
): "text" | "audio" => {
	const mode = searchParams.get("mode");
	if (mode === "text") return "text";
	if (mode === "audio") return "audio";
	return searchParams.get("general_feedback") || searchParams.get("feedback")
		? "text"
		: "audio";
};
