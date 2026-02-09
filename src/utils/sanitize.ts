/**
 * Strip characters that could break prompt structure when injected into system prompt.
 * Removes: control chars, newlines, markdown headers, XML-like tags, null bytes.
 */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // control chars (keep \n \r \t)
    .replace(/[\r\n]+/g, " ") // newlines → space
    .replace(/#{1,6}\s/g, "") // markdown headers
    .replace(/<\/?[a-zA-Z_][^>]*>/g, "") // XML/HTML tags
    .trim()
    .slice(0, 128); // hard length cap for names
}
