export interface LabFiles {
  directory: string;
  read(name: string): Promise<Record<string, unknown> | null>;
  write(name: string, value: unknown): Promise<void>;
  readText(name: string): Promise<string | null>;
  writeText(name: string, value: string): Promise<void>;
}
export function openLab(directory: string): Promise<LabFiles>;
export function lockLab(lab: LabFiles): Promise<() => Promise<void>>;
