export interface PreviewIO {
  run(command: string, args: string[]): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  readFile(path: string, encoding: string): Promise<string>;
  kill(pid: number, signal: string): unknown;
  pause(): Promise<void>;
}
export function switchPreview(udid: string, io?: PreviewIO): Promise<void>;
