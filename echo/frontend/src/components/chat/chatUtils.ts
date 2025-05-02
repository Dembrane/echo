import { formatDate } from "date-fns";

export const formatMessage = (
  message: ChatHistory[number],
  userName: string = "User",
  assistantName: string = "Dembrane",
) => {
  let date = "Unknown";
  try {
    date = formatDate(
      new Date(message._original?.date_created ?? new Date()),
      "MMM d yy, h:mm:ss a",
    );
  } catch (e) {
    console.error(e);
  }

  if (!["user", "dembrane"].includes(message.role)) {
    return ``;
  }

  return `*${message.role === "user" ? userName : assistantName} at ${date}:*\n\n${message.content}\n\n\n\n---`;
};

export function extractMessageMetadata(message: any) {
  if (!Array.isArray(message?.parts)) return [];

  return message.parts
    ?.filter((part: any) => part.type === "source")
    .flatMap((part: any) => {
      const source = part.source?.[0] || {};
      const ratio = source.ratio ?? 0;

      const references = Array.isArray(source.references)
        ? source.references.map((item: ProjectChatMessageMetadata) => ({
            ...item,
            type: "reference",
            ratio: item.ratio ?? ratio,
          }))
        : [];

      const citations = Array.isArray(source.citations)
        ? source.citations.map((item: ProjectChatMessageMetadata) => ({
            ...item,
            type: "citation",
            ratio: item.ratio ?? ratio,
          }))
        : [];

      return [...references, ...citations];
    });
}
