import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { TuiPreferences } from "../../../packages/tui/src/preferences.ts";

/** Explicit startup flags take precedence over the saved interactive session. */
export async function selectInitialSession(
  runtime: Runtime,
  flags: {
    session?: string;
    continue?: boolean;
    new?: boolean;
    demo?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
  },
  preferences: Pick<TuiPreferences, "resumeOnStart">,
) {
  const resume =
    !flags.new &&
    (flags.continue ?? (flags.demo ? false : preferences.resumeOnStart));
  let session = await runtime.session(flags.session, resume);
  if (flags.demo) {
    if (session.modelSelection?.provider !== "demo")
      throw Error(
        "This is a live-model session. Use --demo --new for an offline session.",
      );
    return session;
  }
  if (flags.provider || flags.model || flags.baseUrl) {
    const selected = runtime.defaultSelection();
    // Same-model switches preserve this session's active settings.
    session = await runtime.setModel(
      session,
      selected.provider,
      selected.model,
      undefined,
      flags.baseUrl,
    );
  }
  return session;
}
