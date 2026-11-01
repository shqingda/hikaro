/** Where a slash command runs. View commands are handled by HikaroView itself. */
export type CommandMode = "native" | "attached" | "pi";

type Group = "Session" | "Work" | "Model" | "View" | "Host";

type CommandSpec = {
  name: string;
  /** Arguments as shown in /help, without the command name. */
  usage?: string;
  description: string;
  group: Group;
  modes: readonly CommandMode[];
};

const local = ["native", "attached"] as const;
const all = ["native", "attached", "pi"] as const;

/**
 * The single list of built-in slash commands. Completion, /help and each
 * mode's dispatcher read it; a command a mode does not list stays hidden there.
 */
export const commandSpecs = [
  {
    name: "help",
    description: "Commands and shortcuts",
    group: "View",
    modes: local,
  },
  {
    name: "status",
    description: "Model, context, usage and session status",
    group: "View",
    modes: local,
  },
  {
    name: "new",
    description: "Start a session",
    group: "Session",
    modes: local,
  },
  {
    name: "sessions",
    usage: "[QUERY]",
    description: "List, search, rename or delete sessions",
    group: "Session",
    modes: local,
  },
  {
    name: "resume",
    usage: "[ID]",
    description: "Resume a session",
    group: "Session",
    modes: local,
  },
  {
    name: "delete",
    usage: "[QUERY]",
    description: "Choose a session to delete",
    group: "Session",
    modes: local,
  },
  {
    name: "rename",
    usage: "TITLE",
    description: "Rename this session",
    group: "Session",
    modes: local,
  },
  {
    name: "close",
    description: "Close an idle session; keep running work monitored",
    group: "Session",
    modes: local,
  },
  {
    name: "fork",
    description: "Branch this conversation",
    group: "Session",
    modes: local,
  },
  {
    name: "compact",
    description: "Summarize history into a new session",
    group: "Session",
    modes: local,
  },
  {
    name: "export",
    description: "Export the conversation as Markdown",
    group: "Session",
    modes: local,
  },
  {
    name: "recovery",
    description: "Review receipts and unfinished host commands",
    group: "Host",
    modes: ["attached"],
  },
  {
    name: "reconnect",
    description: "Reconnect to the shared host",
    group: "Host",
    modes: ["attached"],
  },
  {
    name: "plugins",
    description: "Plugin commands and executions on the host",
    group: "Host",
    modes: ["attached"],
  },
  {
    name: "plugin-stop",
    usage: "INVOCATION_ID",
    description: "Request cancellation of a plugin execution",
    group: "Host",
    modes: ["attached"],
  },
  {
    name: "plan",
    usage: "[TASK | cancel | history | progress]",
    description: "Read-only planning, questions and plan review",
    group: "Work",
    modes: local,
  },
  {
    name: "questions",
    description: "Answer or dismiss saved questions",
    group: "Work",
    modes: ["native"],
  },
  {
    name: "tasks",
    usage: "[history [RUN_ID]]",
    description: "Manage queued messages, terminals and child agents",
    group: "Work",
    modes: local,
  },
  {
    name: "changes",
    description: "Review file edits and safely roll them back",
    group: "Work",
    modes: local,
  },
  {
    name: "search",
    usage: "[TEXT]",
    description: "Search full messages in this session",
    group: "Work",
    modes: local,
  },
  {
    name: "attach",
    usage: "PATH",
    description: "Add a file or image; @file works too",
    group: "Work",
    modes: local,
  },
  {
    name: "paste-image",
    description: "Attach a clipboard image (macOS)",
    group: "Work",
    modes: local,
  },
  {
    name: "steer",
    usage: "TEXT",
    description: "Add instructions to the running task",
    group: "Work",
    modes: all,
  },
  {
    name: "follow",
    description: "Toggle whether Enter queues or steers during a run",
    group: "Work",
    modes: all,
  },
  {
    name: "model",
    usage: "[PROVIDER/MODEL]",
    description: "Select a model or connect a provider",
    group: "Model",
    modes: all,
  },
  {
    name: "login",
    usage: "[PROVIDER]",
    description: "Sign in to a provider",
    group: "Model",
    modes: all,
  },
  {
    name: "logout",
    usage: "[PROVIDER]",
    description: "Remove a saved provider sign-in",
    group: "Model",
    modes: all,
  },
  {
    name: "context",
    usage: "[default]",
    description: "Context budget · active or default",
    group: "Model",
    modes: local,
  },
  {
    name: "thinking",
    usage: "[default]",
    description: "Reasoning strength · active or default",
    group: "Model",
    modes: local,
  },
  {
    name: "speed",
    usage: "[default]",
    description: "Service tier · active or default",
    group: "Model",
    modes: local,
  },
  {
    name: "permissions",
    usage: "[ask | auto | full]",
    description: "Workspace approval policy",
    group: "Model",
    modes: local,
  },
  {
    name: "settings",
    description: "Display, notifications and startup preferences",
    group: "View",
    modes: local,
  },
  {
    name: "resources",
    usage: "[QUERY]",
    description: "Loaded skills and workspace instructions",
    group: "View",
    modes: local,
  },
  {
    name: "storage",
    description: "Preview session storage and clean snapshots",
    group: "View",
    modes: local,
  },
  {
    name: "tools",
    description: "Toggle tool details",
    group: "View",
    modes: all,
  },
  {
    name: "older",
    description: "Previous history page",
    group: "View",
    modes: all,
  },
  {
    name: "newer",
    description: "Next history page",
    group: "View",
    modes: all,
  },
  {
    name: "latest",
    description: "Return to the latest messages",
    group: "View",
    modes: all,
  },
  {
    name: "read",
    usage: "NUMBER PART",
    description: "Read a part of a long message",
    group: "View",
    modes: all,
  },
  { name: "quit", description: "Exit", group: "View", modes: all },
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof commandSpecs)[number]["name"];

const specsFor = (mode: CommandMode) =>
  commandSpecs.filter((spec) =>
    (spec.modes as readonly CommandMode[]).includes(mode),
  );

/** Slash completion entries for a mode; login and logout stay out of the way. */
export function commandCompletions(mode: CommandMode) {
  return specsFor(mode)
    .filter((spec) => spec.name !== "login" && spec.name !== "logout")
    .map((spec) => ({
      name: spec.name,
      description:
        "usage" in spec
          ? `${spec.description} · /${spec.name} ${spec.usage}`
          : spec.description,
    }));
}

/** Split "/name rest" into a built-in name, when known, and its argument. */
export function parseCommand(text: string) {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  const name = match?.[1] ?? "";
  return { name, arg: match?.[2] ?? "" };
}

const shortcuts: Record<CommandMode, string> = {
  native:
    "Enter sends · while a run is active Enter steers after the current step (/follow queues instead) · Ctrl+X Enter queues a separate task · Ctrl+C stops · Ctrl+D exits · Shift+Enter adds a line · Ctrl+P actions · Ctrl+O sessions · ![--unrestricted] COMMAND runs a shell command under the current permissions · @file attaches",
  attached:
    "Enter sends · while a run is active Enter steers after the current step (/follow queues instead) · Ctrl+X Enter queues a separate task · Ctrl+C stops the selected task · Ctrl+D detaches · Ctrl+P actions · Ctrl+O sessions · ![--unrestricted] COMMAND runs on the host under its approvals · @file attaches local files",
  pi: "Enter sends · Ctrl+C stops · /back returns to Pi",
};

/** /help text for a mode, grouped, generated from the same list as completion. */
export function commandHelp(mode: CommandMode) {
  const groups = new Map<Group, string[]>();
  for (const spec of specsFor(mode)) {
    const lines = groups.get(spec.group) ?? [];
    lines.push(
      `/${spec.name}${"usage" in spec ? ` ${spec.usage}` : ""} · ${spec.description}`,
    );
    groups.set(spec.group, lines);
  }
  return [
    ...[...groups].map(([group, lines]) => `${group}\n${lines.join("\n")}`),
    `Keys\n${shortcuts[mode]}`,
  ].join("\n\n");
}
