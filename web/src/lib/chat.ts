import type { ChatMessage, PrimitiveTag } from "./types";

function stringArg(tag: PrimitiveTag, key: string): string {
  const value = tag.args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Convert the validated visual protocol into the equivalent readable lesson. */
export function primitiveToMarkdown(tag: PrimitiveTag): string {
  switch (tag.tag) {
    case "title": {
      const title = stringArg(tag, "text") || stringArg(tag, "content");
      return title ? `## ${title}` : "";
    }
    case "text":
      return stringArg(tag, "content");
    case "equation": {
      const latex = stringArg(tag, "latex") || stringArg(tag, "content");
      return latex ? `$$\n${latex}\n$$` : "";
    }
    case "box":
    case "node": {
      const label = stringArg(tag, "label");
      return label ? `- **${label}**` : "";
    }
    case "arrow": {
      const label = stringArg(tag, "label");
      return label ? `- → ${label}` : "";
    }
    case "line": {
      const label = stringArg(tag, "label");
      return label ? `- ${label}` : "";
    }
    case "draw": {
      const caption = stringArg(tag, "caption");
      return caption ? `*Diagram: ${caption}*` : "";
    }
    case "draw_part": {
      const name = stringArg(tag, "name");
      return name ? `*Drawing: ${name}*` : "";
    }
    default:
      return "";
  }
}

export function lessonContext(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant" && message.source !== "chat")
    .map((message) => message.content)
    .filter(Boolean)
    .slice(-4)
    .join("\n\n---\n\n")
    .slice(-20000);
}
