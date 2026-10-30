import { authenticationUrl, openAuthenticationUrl } from "./auth-browser.ts";
import type {
  ProviderCatalog,
  ProviderChoice,
  ModelChoice,
} from "../../provider-pi/src/catalog.ts";
import type {
  ModelPreferences,
  ModelReference,
} from "../../provider-pi/src/model-preferences.ts";
import type { AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { HikaroView } from "./index.ts";
import type { PanelItem } from "./model-panel.ts";

export type ModelPickerCatalog = Pick<
  ProviderCatalog,
  "available" | "providers" | "login" | "refresh"
> &
  Partial<
    Pick<
      ProviderCatalog,
      "logout" | "readPreferences" | "setFavorite" | "recordRecent"
    >
  >;
export type ModelPickerOptions = {
  mode?: "models" | "providers" | "login" | "logout";
  provider?: string;
  current?: ModelReference;
  /** Names the store actually mutated by this adapter, e.g. Local Keychain or Host. */
  ownerLabel?: string;
  saveDefault?: boolean;
  /** Browse remains available while these actions are temporarily unavailable. */
  switchBlockedReason?: () => string | undefined;
  credentialChangeBlockedReason?: (provider: string) => string | undefined;
  affectedSessions?: (provider: string) => string[] | Promise<string[]>;
  onCredentialsChanged?: (
    provider: string,
    action: "login" | "logout",
  ) => void | Promise<void>;
};
const tabs = [
  { value: "models", label: "Models" },
  { value: "providers", label: "Providers" },
];
const key = (model: ModelReference) => `${model.provider}/${model.model}`;
const reference = (model: ModelChoice) => ({
  provider: model.provider,
  model: model.id,
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const cancelled = () => new DOMException("Cancelled", "AbortError");

/** The adapter can finish late; a closed surface must stop awaiting it and ignore its result. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function providerStatus(provider: ProviderChoice, owner: string) {
  if (provider.stored)
    return `${provider.credentialType === "oauth" ? "Account" : "Credential"} saved · ${owner} · availability unverified`;
  if (provider.source === "environment" || provider.configured)
    return `Environment / external configuration${provider.ambientSource ? ` · ${provider.ambientSource}` : ""}`;
  if (provider.source === "unknown")
    return provider.statusReason ?? "Connection status unknown";
  return "Not configured";
}

export function modelDetails(model: ModelChoice) {
  const cap = model.capabilities;
  if (!cap)
    return `${model.provider}/${model.id}\nCapabilities not reported by this backend`;
  const count = (value: number) =>
    value >= 1_000_000
      ? `${value / 1_000_000}M`
      : `${Math.round(value / 1000)}K`;
  return [
    `${model.provider}/${model.id}`,
    `${count(cap.contextWindow)} context · ${count(cap.maxOutputTokens)} output`,
    `${cap.images === undefined ? "Image support unknown" : cap.images ? "Text + images" : "Text"} · Reasoning: ${cap.reasoning.join(", ")}`,
    `Speed: ${cap.speed.join(", ")}`,
    cap.unknown.length ? `Not reported: ${cap.unknown.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function openModelPicker(
  view: Pick<HikaroView, "openModelPanel" | "setError" | "notice">,
  catalog: ModelPickerCatalog,
  select: (
    provider: string,
    model: string,
    makeDefault: boolean,
  ) => Promise<void>,
  mode: boolean | ModelPickerOptions = false,
  configure?: () => Promise<void>,
) {
  const options: ModelPickerOptions =
    typeof mode === "boolean" ? { mode: mode ? "login" : "models" } : mode;
  const { panel, signal, close } = view.openModelPanel();
  const owner = options.ownerLabel ?? "Local credential store";
  let page =
    options.mode === "models" || !options.mode ? "models" : "providers";
  let actionMode = options.mode;
  let providerFilter: string | undefined;
  let warning = "";
  let preferences: ModelPreferences = { favorites: [], recent: [] };
  const queries = { models: "", providers: "" };
  const selections: { models?: string; providers?: string } = {};
  let favoriteOrder: string[] | undefined;
  let authRevision = 0;
  const wait = <T>(work: Promise<T>) => abortable(work, signal);
  const changeBlocked = (provider: string) =>
    options.credentialChangeBlockedReason?.(provider);

  async function authenticate(provider: ProviderChoice): Promise<boolean> {
    const blocked = changeBlocked(provider.id);
    if (blocked) {
      warning = blocked;
      return false;
    }
    if (!provider.methods.length) {
      warning =
        "This provider is configured outside Hikaro. Update its environment or owning host.";
      return false;
    }
    let authError = "";
    for (;;) {
      const method = await panel.choose(
        "Select authentication method",
        provider.methods.map((item) => ({ value: item.id, label: item.label })),
        authError,
        undefined,
        { cancelValue: "__back", search: false },
      );
      if (method.value === "__back") return false;
      const revision = ++authRevision;
      let active = true;
      let promptRevision = 0;
      const live = () => active && revision === authRevision && !signal.aborted;
      const assertLive = () => {
        if (!live()) throw cancelled();
      };
      try {
        panel.progress(`Connecting ${provider.name}… · ${owner}`);
        await wait(
          catalog.login(provider.id, method.value as AuthType, {
            signal,
            prompt: async (prompt: AuthPrompt) => {
              assertLive();
              prompt.signal?.throwIfAborted();
              const currentPrompt = ++promptRevision;
              const answer =
                prompt.type === "select"
                  ? panel
                      .choose(
                        prompt.message,
                        prompt.options.map((item) => ({
                          value: item.id,
                          label: item.label,
                          description: item.description,
                        })),
                      )
                      .then((item) => item.value)
                  : panel.prompt(
                      prompt.message,
                      prompt.type === "secret" || prompt.type === "manual_code",
                    );
              const abort = () => {
                if (live() && currentPrompt === promptRevision)
                  panel.cancelPrompt();
              };
              prompt.signal?.addEventListener("abort", abort, { once: true });
              if (prompt.signal?.aborted) abort();
              try {
                const value = await wait(answer);
                assertLive();
                return value;
              } finally {
                prompt.signal?.removeEventListener("abort", abort);
              }
            },
            notify: (event) => {
              if (!live()) return;
              const url = authenticationUrl(event);
              if (url)
                void openAuthenticationUrl(url).catch((error) => {
                  if (live()) panel.showError(message(error));
                });
              if (event.type === "auth_url")
                panel.progress(
                  [event.instructions, event.url].filter(Boolean).join("\n"),
                );
              else if (event.type === "device_code")
                panel.progress(
                  `Code: ${event.userCode}\n${event.verificationUri}`,
                );
              else panel.progress(event.message);
            },
          }),
        );
        assertLive();
        await wait(
          Promise.resolve(options.onCredentialsChanged?.(provider.id, "login")),
        );
        panel.progress("Credential saved. Refreshing model catalog…");
        const error = await wait(catalog.refresh(provider.id, signal));
        warning = error
          ? `Credential saved; model refresh failed: ${error}. Showing cached models.`
          : `Credential saved in ${owner}. Model access is checked when used.`;
        providerFilter = provider.id;
        queries.models = "";
        selections.models = undefined;
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        authError = message(error);
      } finally {
        active = false;
      }
    }
  }

  async function confirmChange(
    provider: ProviderChoice,
    action: "login" | "logout",
  ) {
    const blocked = changeBlocked(provider.id);
    if (blocked) {
      warning = blocked;
      return false;
    }
    const sessions = await wait(
      Promise.resolve(options.affectedSessions?.(provider.id) ?? []),
    );
    const label = action === "logout" ? "Sign out" : "Replace sign-in";
    const details = [
      `${label} for ${provider.name} in ${owner}.`,
      "This changes the saved credential for this provider, not the model selection.",
      sessions.length
        ? `Affected sessions:\n${sessions.join("\n")}`
        : "Other sessions using this credential store may be affected.",
      provider.ambientSource
        ? `Environment source ${provider.ambientSource} remains configured.`
        : "Environment and external credentials are not removed.",
    ].join("\n");
    const choice = await panel.choose(
      `${label} · ${provider.name}`,
      [
        { value: "cancel", label: "Cancel" },
        { value: "confirm", label },
      ],
      details,
      undefined,
      {
        search: false,
        selectedValue: "cancel",
        cancelValue: "cancel",
        requireNoticeVisible: true,
      },
    );
    if (choice.value !== "confirm") return false;
    const nowBlocked = changeBlocked(provider.id);
    if (nowBlocked) {
      warning = nowBlocked;
      return false;
    }
    return true;
  }

  async function logout(provider: ProviderChoice) {
    if (!catalog.logout || !provider.stored) {
      warning = provider.stored
        ? `Sign-out is managed by ${owner}.`
        : "No saved credential to remove. Environment and external credentials are managed outside Hikaro.";
      return;
    }
    if (!(await confirmChange(provider, "logout"))) return;
    panel.progress(`Removing saved credential from ${owner}…`);
    await wait(catalog.logout(provider.id, signal));
    await wait(
      Promise.resolve(options.onCredentialsChanged?.(provider.id, "logout")),
    );
    warning = `Saved credential removed from ${owner}. Environment and external configuration are unchanged.`;
  }

  async function manageProvider(provider: ProviderChoice) {
    if (actionMode === "logout") {
      actionMode = "providers";
      await logout(provider);
      return;
    }
    if (actionMode === "login") {
      actionMode = "providers";
      if (
        (!provider.stored || (await confirmChange(provider, "login"))) &&
        (await authenticate(provider))
      )
        page = "models";
      return;
    }
    for (;;) {
      const fresh = (await wait(catalog.providers())).find(
        (item) => item.id === provider.id,
      );
      if (!fresh) {
        warning = "Provider is no longer available";
        return;
      }
      provider = fresh;
      const picked = await panel.choose(
        provider.name,
        [
          { value: "models", label: "View models" },
          ...(provider.methods.length
            ? [
                {
                  value: "login",
                  label: provider.stored ? "Sign in again…" : "Connect…",
                },
              ]
            : []),
          ...(provider.stored && catalog.logout
            ? [{ value: "logout", label: "Sign out…" }]
            : []),
          { value: "refresh", label: "Refresh model catalog" },
          { value: "back", label: "Back to providers" },
        ],
        [
          warning,
          providerStatus(provider, owner),
          provider.ambientSource && provider.stored
            ? `Fallback: ${provider.ambientSource}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        undefined,
        { search: false, cancelValue: "back", enterAction: "open" },
      );
      warning = "";
      if (picked.value === "back") return;
      if (picked.value === "models") {
        providerFilter = provider.id;
        queries.models = "";
        selections.models = undefined;
        page = "models";
        return;
      }
      if (picked.value === "login") {
        if (
          (!provider.stored || (await confirmChange(provider, "login"))) &&
          (await authenticate(provider))
        ) {
          page = "models";
          return;
        }
      } else if (picked.value === "logout") {
        await logout(provider);
        return;
      } else {
        panel.progress("Refreshing model catalog…");
        const error = await wait(catalog.refresh(provider.id, signal));
        warning = error
          ? `Refresh failed: ${error}. Cached models remain available.`
          : "Model catalog refreshed; model access is checked when used.";
      }
    }
  }

  async function openProvider(provider: ProviderChoice) {
    try {
      await manageProvider(provider);
    } catch (error) {
      if (signal.aborted) throw error;
      warning = message(error);
    }
  }

  try {
    panel.progress("Loading model center…");
    if (catalog.readPreferences) {
      try {
        preferences = await wait(catalog.readPreferences());
      } catch (error) {
        if (signal.aborted) throw error;
        warning = `Could not load model preferences: ${message(error)}`;
      }
    }
    if (options.provider && page === "providers") {
      const provider = (await wait(catalog.providers())).find(
        (item) => item.id === options.provider,
      );
      if (provider) await openProvider(provider);
      else warning = `Unknown provider: ${options.provider}`;
    }
    for (;;) {
      signal.throwIfAborted();
      if (page === "providers") {
        favoriteOrder = undefined;
        const providers = await wait(catalog.providers());
        const picked = await panel.choose(
          "Select provider to configure",
          providers.map((provider) => ({
            value: provider.id,
            label: provider.name,
            description: provider.stored
              ? "Saved"
              : provider.configured
                ? "Environment"
                : provider.source === "unknown"
                  ? "Unknown"
                  : "Not configured",
            detail: providerStatus(provider, owner),
            section: provider.configured ? "Configured" : "Available providers",
          })),
          warning,
          undefined,
          {
            search: true,
            searchQuery: queries.providers,
            selectedValue: selections.providers,
            emptyMessage: "No matching providers",
            tabs,
            activeTab: page,
            enterAction: "manage",
          },
        );
        queries.providers = picked.query ?? "";
        selections.providers = picked.value;
        warning = "";
        if (picked.action === "tab") {
          page = "models";
          providerFilter = undefined;
          continue;
        }
        const provider = providers.find((item) => item.id === picked.value);
        if (provider) await openProvider(provider);
        continue;
      }
      const choices = await wait(catalog.available(providerFilter));
      favoriteOrder ??= preferences.favorites.map(key);
      const recentOrder = preferences.recent.map(key);
      const rows: PanelItem[] = choices
        .map((model) => {
          const id = key(reference(model));
          const favorite = preferences.favorites.some(
            (item) => key(item) === id,
          );
          return {
            value: id,
            label: `${favorite ? "★ " : ""}${model.name}`,
            description: `${model.provider}${model.capabilities ? ` · ${Math.round(model.capabilities.contextWindow / 1000)}K context` : ""}`,
            section: favoriteOrder!.includes(id)
              ? "Favorites"
              : recentOrder.includes(id)
                ? "Recent"
                : model.provider,
            detail: modelDetails(model),
            searchText: `${model.provider} ${model.id}`,
          };
        })
        .sort((a, b) => {
          const rank = (row: PanelItem) =>
            favoriteOrder!.includes(row.value)
              ? 0
              : recentOrder.includes(row.value)
                ? 1
                : 2;
          return (
            rank(a) - rank(b) ||
            (rank(a) === 1
              ? recentOrder.indexOf(a.value) - recentOrder.indexOf(b.value)
              : 0) ||
            a.section!.localeCompare(b.section!) ||
            a.label.replace(/^★ /, "").localeCompare(b.label.replace(/^★ /, ""))
          );
        });
      const blocked = options.switchBlockedReason?.();
      const picked = await panel.choose(
        "Select model",
        [
          ...rows,
          ...(providerFilter
            ? [{ value: "__all", label: "View all models" }]
            : []),
          { value: "__providers", label: "Manage providers / accounts" },
          ...(configure
            ? [{ value: "__settings", label: "Model settings" }]
            : []),
        ],
        [...new Set([warning, blocked].filter(Boolean))].join("\n"),
        undefined,
        {
          search: true,
          searchQuery: queries.models,
          selectedValue:
            selections.models ??
            (options.current ? key(options.current) : undefined),
          emptyMessage: "No matching models · Tab opens Providers",
          tabs,
          activeTab: page,
          enterAction: "select",
          allowDefault: (item) =>
            options.saveDefault !== false &&
            !blocked &&
            rows.some((row) => row.value === item.value),
          actions: catalog.setFavorite
            ? [
                {
                  id: "favorite",
                  key: "ctrl+f",
                  label: (item) =>
                    preferences.favorites.some(
                      (model) => key(model) === item?.value,
                    )
                      ? "unfavorite"
                      : "favorite",
                  enabled: (item) =>
                    rows.some((row) => row.value === item.value),
                },
              ]
            : [],
        },
      );
      queries.models = picked.query ?? "";
      selections.models = picked.value;
      warning = "";
      if (picked.action === "tab" || picked.value === "__providers") {
        page = "providers";
        actionMode = "providers";
        continue;
      }
      if (picked.value === "__all") {
        providerFilter = undefined;
        queries.models = "";
        favoriteOrder = undefined;
        continue;
      }
      if (picked.value === "__settings") {
        close();
        await configure!();
        return;
      }
      const model = choices.find(
        (item) => key(reference(item)) === picked.value,
      );
      if (!model) continue;
      if (picked.action === "favorite") {
        const ref = reference(model);
        const enabled = !preferences.favorites.some(
          (item) => key(item) === key(ref),
        );
        try {
          await wait(catalog.setFavorite!(ref, enabled));
          preferences.favorites = [
            ...preferences.favorites.filter((item) => key(item) !== key(ref)),
            ...(enabled ? [ref] : []),
          ];
        } catch (error) {
          if (signal.aborted) throw error;
          warning = `Could not save favorite: ${message(error)}`;
        }
        continue;
      }
      const reason = options.switchBlockedReason?.();
      if (reason) {
        warning = reason;
        continue;
      }
      try {
        panel.progress("Applying model selection…");
        // A successful selection may rebind the view and close this panel. Record
        // the actual selection even then, without painting into the new surface.
        await wait(
          select(model.provider, model.id, picked.makeDefault).then(
            async () => {
              try {
                await catalog.recordRecent?.(reference(model));
              } catch (error) {
                if (!signal.aborted)
                  view.notice(
                    `Model selected; recent preference could not be saved: ${message(error)}`,
                  );
              }
            },
          ),
        );
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        warning = message(error);
      }
    }
  } catch (error) {
    if (!signal.aborted) view.setError(message(error));
  } finally {
    authRevision++;
    close();
  }
}
