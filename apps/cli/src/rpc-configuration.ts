import { z } from "zod";
import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { ModelSelection } from "../../../packages/core/src/types.ts";
import { permissionModeSchema } from "../../../packages/runtime/src/permissions.ts";
export const modelSettingsSchema = z
  .object({
    contextWindow: z.number().int().min(1024).max(10000000).optional(),
    reasoning: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    speed: z.enum(["default", "priority", "flex"]).optional(),
  })
  .strict();
export async function validateSettings(
  runtime: Runtime,
  selection: ModelSelection,
) {
  const cap = await runtime
    .providerCatalog()
    .capabilities(selection.provider, selection.model);
  const s = selection.settings;
  if (
    (s.contextWindow !== undefined && s.contextWindow > cap.contextWindow) ||
    (s.reasoning !== undefined &&
      !cap.reasoning.some((v) => v === s.reasoning)) ||
    (s.speed !== undefined && !cap.speed.some((v) => v === s.speed))
  )
    throw Error("Model settings exceed the selected model's capabilities");
}
export type ResourceEntry = {
  name: string;
  kind: string;
  description: string;
  path?: string;
};
export async function configurationRequest(
  runtime: Runtime,
  method: string,
  p: Record<string, unknown>,
) {
  switch (method) {
    case "model.capabilities":
      return runtime
        .providerCatalog()
        .capabilities(
          z.string().min(1).max(128).parse(p.provider),
          z.string().min(1).max(256).parse(p.model),
        );
    case "providers.reload":
      runtime.reloadProviderCatalog();
      return { reloaded: true };
    case "permissions.set":
      return {
        mode: await runtime.setPermissionMode(
          permissionModeSchema.parse(p.mode),
        ),
      };
    case "resources.list": {
      const entries: ResourceEntry[] = [
        ...runtime.resources.skills.map((s) => ({ ...s, kind: "Skill" })),
        ...runtime.resources.instructions.map((path) => ({
          name: path,
          kind: "Instructions",
          path,
          description: "Loaded workspace instructions",
        })),
        ...[...runtime.tools.names()].map((name) => ({
          name,
          kind: "Tool",
          description: runtime.tools.get(name)!.description,
        })),
        ...[...runtime.plugins.commands.keys()].map((name) => ({
          name,
          kind: "Plugin command",
          description:
            "Loaded on host. Use /plugins to invoke with confirmation.",
        })),
        ...[...runtime.plugins.views.keys()].map((name) => ({
          name,
          kind: "Plugin view",
          description:
            "Loaded on host. Use /plugins to read the rendered text.",
        })),
      ];
      const query = z
        .string()
        .max(200)
        .parse(p.query ?? "")
        .toLowerCase();
      const filtered = entries.filter((r) =>
        (r.name + " " + r.kind + " " + r.description)
          .toLowerCase()
          .includes(query),
      );
      const offset = z
        .number()
        .int()
        .min(0)
        .parse(p.offset ?? 0);
      const items: ResourceEntry[] = [];
      let bytes = 0;
      for (const entry of filtered.slice(offset, offset + 50)) {
        const item = {
          ...entry,
          name: entry.name.slice(0, 4096),
          description: entry.description.slice(0, 4096),
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > 128000) break;
        items.push(item);
        bytes += size;
      }
      return { items, hasMore: offset + items.length < filtered.length };
    }
    default:
      throw Error("Unknown configuration method");
  }
}
