// Discord rejects message content longer than this
export const MAX_CONTENT_LENGTH = 2000;

// Every message is meant as plain text, but Discord renders markdown and masked
// links, so a game name or error string could otherwise format or link itself.
// Inline markers are escaped everywhere; heading, list and quote markers only
// act at the start of a line, so they are escaped only there.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]]/g, '\\$&').replace(/^(\s*)([#>-])/gm, '$1\\$2');
}

// Splits text into chunks Discord accepts, breaking at line boundaries where
// possible so a long daily report arrives as consecutive readable messages.
export function splitMessage(text: string, max = MAX_CONTENT_LENGTH): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (current) chunks.push(current);
      current = '';
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > max) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  // Discord rejects empty or whitespace-only content
  return chunks.filter((c) => c.trim().length > 0);
}

// Error text can quote a request URL (webhook and interaction-callback URLs
// embed tokens), so known secrets and every URL are cut before it is logged.
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<token>');
  }
  return out.replace(/https?:\/\/\S+/g, '<url>');
}
