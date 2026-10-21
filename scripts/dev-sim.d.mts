export const DEVICE: string;
export interface SimulatorIO {
  log(message: string): void;
  pause(): Promise<void>;
  run(
    command: string,
    args: string[],
    allowFailure?: boolean,
  ): Promise<string | null>;
  start(command: string, args: string[], name: string): void;
  fetchText(url: string): Promise<string | null>;
  readPreview(): Promise<{ device: string; port: number; pid: number } | null>;
}
export function launchSimulator(
  io: SimulatorIO,
  options?: { openBrowser?: boolean },
): Promise<void>;
