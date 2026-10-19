/** Host access is explicit; an unavailable sandbox must never cause fallback. */
export function parseManualCommand(text: string) {
  const body = text.slice(1).trim();
  const unrestricted = /^--unrestricted(?:\s|$)/.test(body);
  const command = unrestricted
    ? body.slice("--unrestricted".length).trim()
    : body;
  if (!command) throw Error("Use ![--unrestricted] COMMAND");
  return { command, unrestricted };
}
