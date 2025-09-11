import { directus } from "@/lib/directus";
import { readItem } from "@directus/sdk";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { useParams } from "react-router";

const MAX_QUOTES = 25;

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
              {
                representative_quotes: [
                  {
                    quote_id: [
                      {
                        conversation_id: ["id", "participant_name"],
                      },
                      "text",
                    ],
                  },
                ],
              },
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

    for (const aspect of view.aspects ?? []) {
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

      let count = 0;

      if (
        aspect.representative_quotes &&
        (aspect.representative_quotes as unknown as any).length > 0
      ) {
        stringBuilder.push(`#### Top Quotes for ${aspect.name}`);

        // @ts-expect-error type of representative_quotes is not known
        for (const { quote_id } of aspect.representative_quotes ?? []) {
          const conversationUrl =
            window.location.origin +
            `/${language}/projects/${projectId}/conversation/${quote_id.conversation_id.id}/transcript`;

          stringBuilder.push(`"${quote_id.text}"\n`);
          stringBuilder.push(
            `from [${quote_id.conversation_id?.participant_name}](${conversationUrl})\n\n`,
          );

          count++;

          if (count > MAX_QUOTES) break;
        }
      }
    }

    copy(stringBuilder.join("\n"));
  };

  return {
    copyView,
    copied,
  };
};
