import { authenticationUrl, openAuthenticationUrl } from "./auth-browser.ts";
import type { ProviderCatalog } from "../../provider-pi/src/catalog.ts";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { HikaroView } from "./index.ts";
export async function openModelPicker(
  view: HikaroView,
  catalog: Pick<
    ProviderCatalog,
    "available" | "providers" | "login" | "refresh"
  >,
  select: (
    provider: string,
    model: string,
    makeDefault: boolean,
  ) => Promise<void>,
  loginOnly = false,
  configure?: () => Promise<void>,
) {
  const { panel, signal, close } = view.openModelPanel();
  let warning = "";
  const models = async (provider?: string): Promise<boolean> => {
    const choices = await catalog.available(provider);
    if (!choices.length) return false;
    for (;;) {
      const choice = await panel.choose(
        "Select model",
        [
          ...choices.map((m) => ({
            value: m.provider + "/" + m.id,
            label: m.name,
            description: m.provider + "/" + m.id,
          })),
          { value: "__providers", label: "Connect / configure a provider" },
          ...(configure
            ? [
                {
                  value: "__settings",
                  label: "Settings",
                },
              ]
            : []),
        ],
        warning,
        undefined,
        {
          search: true,
          emptyMessage: "No matching models",
          allowDefault: (item) =>
            choices.some(
              (model) => model.provider + "/" + model.id === item.value,
            ),
          enterAction: "select",
        },
      );
      if (choice.value === "__settings") {
        close();
        await configure!();
        return true;
      }
      if (choice.value === "__providers") return false;
      const m = choices.find((m) => m.provider + "/" + m.id === choice.value)!;
      try {
        await select(m.provider, m.id, choice.makeDefault);
        return true;
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
      }
    }
  };
  try {
    panel.progress("Loading providers…");
    if (!loginOnly && (await models())) return;
    for (;;) {
      const providers = await catalog.providers();
      signal.throwIfAborted();
      const picked = await panel.choose(
        "Select provider to configure",
        providers.map((p) => ({
          value: p.id,
          label: p.name,
          description: p.configured
            ? p.stored
              ? "✓ stored"
              : "✓ configured"
            : "not configured",
        })),
        warning,
        undefined,
        { search: true, emptyMessage: "No matching providers" },
      );
      const provider = providers.find((p) => p.id === picked.value)!;
      if (!provider.configured || loginOnly) {
        if (!provider.methods.length) {
          warning = "Configure this provider in the host environment.";
          continue;
        }
        let authError = "";
        for (;;) {
          const method = await panel.choose(
            "Select authentication method",
            provider.methods.map((m) => ({ value: m.id, label: m.label })),
            authError,
          );
          try {
            panel.progress("Connecting…");
            await catalog.login(
              provider.id,
              method.value as "oauth" | "api_key",
              {
                signal,
                prompt: async (prompt: AuthPrompt) => {
                  if (prompt.signal?.aborted)
                    throw new DOMException("Cancelled", "AbortError");
                  const answer =
                    prompt.type === "select"
                      ? panel
                          .choose(
                            prompt.message,
                            prompt.options.map((o) => ({
                              value: o.id,
                              label: o.label,
                              description: o.description,
                            })),
                          )
                          .then((s) => s.value)
                      : panel.prompt(prompt.message, prompt.type === "secret");
                  if (!prompt.signal) return answer;
                  return new Promise<string>((resolve, reject) => {
                    const abort = () => {
                      panel.cancelPrompt();
                      reject(new DOMException("Cancelled", "AbortError"));
                    };
                    prompt.signal!.addEventListener("abort", abort, {
                      once: true,
                    });
                    if (prompt.signal!.aborted) abort();
                    answer.then(
                      (value) => {
                        prompt.signal!.removeEventListener("abort", abort);
                        resolve(value);
                      },
                      (error) => {
                        prompt.signal!.removeEventListener("abort", abort);
                        reject(error);
                      },
                    );
                  });
                },
                notify: (event) => {
                  const url = authenticationUrl(event);
                  if (url)
                    void openAuthenticationUrl(url).catch((error) =>
                      panel.showError(String(error)),
                    );
                  if (event.type === "auth_url") {
                    panel.progress(
                      [event.instructions, event.url]
                        .filter(Boolean)
                        .join("\n"),
                    );
                  } else if (event.type === "device_code")
                    panel.progress(
                      `Code: ${event.userCode}\n${event.verificationUri}`,
                    );
                  else panel.progress(event.message);
                },
              },
            );
            break;
          } catch (e) {
            if (signal.aborted) throw e;
            authError = e instanceof Error ? e.message : String(e);
          }
        }
      }
      panel.progress("Refreshing models…");
      warning = (await catalog.refresh(provider.id, signal))
        ? "Could not refresh " + provider.name + "; showing cached models."
        : "";
      if (await models(provider.id)) return;
      warning ||=
        "No models available. Configure another provider or retry sign-in.";
    }
  } catch (e) {
    if (!signal.aborted)
      view.setError(e instanceof Error ? e.message : String(e));
  } finally {
    close();
  }
}
