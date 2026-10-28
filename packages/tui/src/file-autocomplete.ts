import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteSuggestions,
} from "./primitives.ts";

/** Search only on demand; never scan the workspace on the startup path. */
export class FileAutocompleteProvider extends CombinedAutocompleteProvider {
  constructor(
    commands: ConstructorParameters<typeof CombinedAutocompleteProvider>[0],
    private readonly cwd: string,
  ) {
    // Mode-specific commands override built-ins without adding duplicate rows.
    const unique = new Map(
      (commands ?? []).map((command) => [
        "name" in command ? command.name : command.value,
        command,
      ]),
    );
    super([...unique.values()], cwd);
  }

  override async getSuggestions(
    lines: string[],
    line: number,
    col: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[line] ?? "").slice(0, col);
    const match = before.match(/(?:^|\s)(@"[^"\n]*|@[^\s"'`]*)$/);
    if (!match) return super.getSuggestions(lines, line, col, options);
    const prefix = match[1]!;
    const query = prefix.slice(prefix.startsWith('@"') ? 2 : 1);
    const slash = query.lastIndexOf("/");
    const base = slash < 0 ? "" : query.slice(0, slash + 1);
    const needle = query.slice(slash + 1);
    const directory = resolve(
      this.cwd,
      base.startsWith("~/") ? homedir() + base.slice(1) : base || ".",
    );
    if (options.signal.aborted) return null;
    const paths = await new Promise<string[]>((done) => {
      execFile(
        "rg",
        ["--files", "--hidden", "-0", "-g", "!.git", "--", "."],
        {
          cwd: directory,
          signal: options.signal,
          timeout: 1500,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (options.signal.aborted || (error && !stdout)) return done([]);
          // A truncated final record must never become a candidate.
          done(
            stdout
              .slice(0, Math.max(0, stdout.lastIndexOf("\0")))
              .split("\0")
              .filter(Boolean),
          );
        },
      );
    });
    if (options.signal.aborted) return null;
    const candidates = new Set<string>();
    let scanned = 0;
    for (const raw of paths.slice(0, 20_000)) {
      if (++scanned % 256 === 0) {
        await new Promise<void>((done) => setImmediate(done));
        if (options.signal.aborted) return null;
      }
      const path = raw.replace(/^\.\//, "");
      // Control characters and quoting escapes cannot round-trip through the editor.
      if (/[\x00-\x1f\x7f"\\]/.test(path)) continue;
      candidates.add(path);
      for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
        candidates.add(path.slice(0, i + 1));
    }
    // Rank in small batches so a large repository cannot monopolize input handling.
    let best: string[] = [];
    const entries = [...candidates];
    for (let i = 0; i < entries.length; i += 256) {
      const batch = entries
        .slice(i, i + 256)
        .sort(
          (a, b) =>
            a.split("/").length - b.split("/").length || a.localeCompare(b),
        );
      best = fuzzyFilter([...best, ...batch], needle, (path) => path).slice(
        0,
        20,
      );
      await new Promise<void>((done) => setImmediate(done));
      if (options.signal.aborted) return null;
    }
    const items = best.map((path) => {
      const full = base + path;
      return {
        value:
          /\s/.test(full) || prefix.startsWith('@"')
            ? `@"${full}"`
            : `@${full}`,
        label: path,
        description: base ? full : undefined,
      };
    });
    return items.length ? { prefix, items } : null;
  }
}
