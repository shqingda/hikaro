import type { ResourceInstall } from "../../runtime/src/resources.ts";

/** Shared command grammar for local and attached TUIs. Other text remains a search. */
export async function resourceCommand(
  argument: string,
  source: {
    reload(): Promise<{ skills: number; instructions: number }>;
    install(
      request: ResourceInstall,
    ): Promise<{ path: string; restartRequired: boolean }>;
  },
) {
  const text = argument.trim();
  if (text === "reload") {
    const result = await source.reload();
    return `Reloaded ${result.skills} skills and ${result.instructions} instruction files. Ask the agent by skill name; standalone /skill:NAME works now, with new autocomplete entries after restarting that TUI. Plugin code and server configuration changes require a host restart.`;
  }
  if (!/^install(?:\s|$)/.test(text)) return undefined;
  const match = /^install\s+(skill|plugin)\s+(.+)\s+--trusted$/.exec(text);
  if (!match)
    throw Error(
      "Use /resources install skill|plugin PATH --trusted to explicitly trust a local source. Skills use a directory containing SKILL.md; plugins use a module file.",
    );
  const rawPath = match[2]!.trim();
  const path: unknown = rawPath.startsWith('"') ? JSON.parse(rawPath) : rawPath;
  if (typeof path !== "string" || !path)
    throw Error("Enter a local resource path");
  const result = await source.install({
    kind: match[1] as "skill" | "plugin",
    path,
    trusted: true,
  });
  return `Registered local ${match[1]} in place: ${result.path}\nKeep this source available. ${result.restartRequired ? "Restart the host to load this trusted plugin." : "Use /resources reload to load the skill and workspace instructions."}`;
}
