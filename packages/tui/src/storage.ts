export type StoragePreview = Awaited<
  ReturnType<import("../../runtime/src/index.ts").Runtime["previewCleanup"]>
>;
export async function storageCommand(
  argument: string,
  source: {
    preview(): Promise<StoragePreview>;
    clean(token: string): Promise<{ files: number; bytes: number }>;
  },
) {
  if (!argument.trim() || argument.trim() === "preview") {
    const p = await source.preview();
    return `Session storage (logical bytes)\nSnapshots: ${p.usage.snapshots}\nTool outputs (retained): ${p.usage.toolOutputs}\nChange metadata (retained): ${p.usage.metadata}\nExcluded/shared files: ${p.usage.excludedFiles}\n\n${p.warning}\n\nThis preview: ${p.files} files / ${p.bytes} bytes (up to 1,000 files / 64 MiB per operation).\nTo confirm this exact cleanup: /storage clean ${p.token}`;
  }
  const match = /^clean ([a-f0-9]{64})$/.exec(argument.trim());
  if (!match)
    throw Error(
      "Use /storage to preview, then /storage clean TOKEN to explicitly confirm",
    );
  const result = await source.clean(match[1]!);
  return `Removed ${result.files} snapshot files / ${result.bytes} logical bytes. Change records remain; missing snapshot details cannot be diffed or rolled back.`;
}
