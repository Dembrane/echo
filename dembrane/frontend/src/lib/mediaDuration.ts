// The file's length in seconds as the browser reads it, or null when it can't tell.
export function readMediaSeconds(
	file: File,
	timeoutMs = 5000,
): Promise<number | null> {
	if (typeof document === "undefined") return Promise.resolve(null);
	return new Promise((resolve) => {
		const el = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		);
		const url = URL.createObjectURL(file);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (seconds: number | null) => {
			clearTimeout(timer);
			el.removeEventListener("loadedmetadata", onMeta);
			el.removeEventListener("error", onError);
			el.removeAttribute("src");
			URL.revokeObjectURL(url);
			resolve(seconds);
		};
		const onMeta = () =>
			done(
				Number.isFinite(el.duration) && el.duration >= 0 ? el.duration : null,
			);
		const onError = () => done(null);
		el.addEventListener("loadedmetadata", onMeta);
		el.addEventListener("error", onError);
		timer = setTimeout(() => done(null), timeoutMs);
		el.preload = "metadata";
		el.src = url;
	});
}
