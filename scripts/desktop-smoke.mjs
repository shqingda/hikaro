import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const home = await mkdtemp(join(tmpdir(), "hikaro-desktop-"));
const app = await electron.launch({
  args: [resolve("apps/desktop")],
  env: { ...process.env, HIKARO_DEMO: "1", HIKARO_HOME: home },
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error(e.message));
  await page.getByRole("heading", { name: "New session" }).waitFor();
  await page
    .getByRole("textbox", { name: "Message Hikaro" })
    .fill("Hello from the desktop");
  await page.getByRole("button", { name: "Send ↑" }).click();
  await page
    .getByText("You wrote: Hello from the desktop", { exact: false })
    .waitFor();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "artifacts/desktop-dark.png" });
  console.log(
    "Electron smoke passed: renderer → isolated preload → RPC → core → streamed response",
  );
} finally {
  await app.close();
  await rm(home, { recursive: true, force: true });
}
