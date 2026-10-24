/** Owns only the original process group, never observed detached descendants. */
export class ProcessGroup {
  private gone = false;
  constructor(private readonly pid: number) {}
  signal(value: NodeJS.Signals | 0) {
    if (process.platform === "win32" || this.pid <= 1)
      throw Error("Cannot safely stop this process group");
    if (this.gone) return false;
    try {
      process.kill(-this.pid, value);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        this.gone = true;
        return false;
      }
      // A denied probe does not prove absence; termination errors remain errors.
      if (value === 0 && code === "EPERM") return true;
      throw error;
    }
  }
  async stop(exited: () => boolean) {
    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;
      do {
        if (!this.signal(0) && exited()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return false;
    };
    this.signal("SIGTERM");
    if (!(await wait(1000))) {
      this.signal("SIGKILL");
      if (!(await wait(2000)))
        throw Error(
          "Process group termination could not be confirmed; retry stop",
        );
    }
  }
}
