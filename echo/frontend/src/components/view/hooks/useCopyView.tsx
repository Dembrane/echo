import { readItem } from "@directus/sdk";
import { useParams } from "react-router";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { directus } from "@/lib/directus";

export const useCopyView = () => {
	const { language, projectId } = useParams();
	const { copied, copy } = useCopyToRichText();

	const copyView = async (viewId: string) => {
		const stringBuilder: string[] = [];
		const view = await directus.request(
			readItem("view", viewId, {
				fields: [
					"name",
					"summary",
					{
						aspects: [
							"id",
							"name",
							"short_summary",
							"long_summary",
							"image_url",
						],
					},
				],
			}),
		);

		// http://localhost:5173/en-US/projects/f65cd477-9f4c-4067-80e5-43634bb1dcb4/library/views/3af65db5-53b9-4641-b482-3982bbc6b9be
		stringBuilder.push(
			`# View: [${view.name}](${window.location.origin}/${language}/projects/${projectId}/library/views/${viewId})`,
		);

		if (view.summary) {
			stringBuilder.push(view.summary);
		} else {
			stringBuilder.push(
				"The summary for this view is not available. Please try again later.",
			);
		}

		stringBuilder.push("## Aspects");

		for (const aspect of view.aspects as Aspect[]) {
			// http://localhost:5173/en-US/projects/f65cd477-9f4c-4067-80e5-43634bb1dcb4/library/views/3af65db5-53b9-4641-b482-3982bbc6b9be/aspects/0b9d5691-d31b-430f-ab28-c38f86c078f4
			stringBuilder.push(
				`### [${aspect.name}](${window.location.origin}/${language}/projects/${projectId}/library/views/${viewId}/aspects/${aspect.id})`,
			);

			if (aspect.image_url) {
				stringBuilder.push(`![${aspect.name}](${aspect.image_url})`);
			}

			if (aspect.long_summary) {
				stringBuilder.push(aspect.long_summary);
			} else if (aspect.short_summary) {
				stringBuilder.push(aspect.short_summary);
			} else {
				stringBuilder.push(
					"The summary for this aspect is not available. Please try again later.",
				);
			}
		}

		copy(stringBuilder.join("\n"));
	};

	return {
		copied,
		copyView,
	};
};
