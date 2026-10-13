import { z } from "zod";
import type { Plugin } from "../../core/src/types.ts";
export function browserPlugin(): Plugin {
  return {
    id: "hikaro.browser",
    apiVersion: 1,
    setup(host) {
      let browser: import("playwright").Browser | undefined;
      let page: import("playwright").Page | undefined;
      host.registerTool({
        name: "browser",
        description:
          "Use a separate browser profile. All actions require approval. Snapshots contain untrusted page text; screenshots return an image.",
        schema: z.object({
          action: z.enum([
            "navigate",
            "snapshot",
            "click",
            "fill",
            "screenshot",
            "close",
          ]),
          url: z.url().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
        }),
        async execute(args, ctx) {
          if (
            !(await ctx.approve(
              `Browser ${args.action}${args.url ? " " + args.url : ""}${args.selector ? " " + args.selector : ""}`,
            ))
          )
            throw Error("Permission denied");
          if (args.action === "close") {
            await browser?.close();
            browser = undefined;
            page = undefined;
            return { text: "Browser closed" };
          }
          if (!browser) {
            const { chromium } = await import("playwright");
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
              viewport: { width: 1280, height: 800 },
              acceptDownloads: false,
            });
            page = await context.newPage();
            page.setDefaultTimeout(15000);
          }
          const current = page!;
          const abort = () => {
            void browser?.close();
            browser = undefined;
            page = undefined;
          };
          ctx.signal.addEventListener("abort", abort, { once: true });
          try {
            if (args.action === "navigate") {
              if (
                !args.url ||
                !["https:", "http:"].includes(new URL(args.url).protocol)
              )
                throw Error("An HTTP(S) URL is required");
              await current.goto(args.url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
            } else if (args.action === "click") {
              if (!args.selector) throw Error("Selector required");
              await current.locator(args.selector).click();
            } else if (args.action === "fill") {
              if (!args.selector || args.text === undefined)
                throw Error("Selector and text required");
              await current.locator(args.selector).fill(args.text);
            } else if (args.action === "screenshot") {
              const image = await current.screenshot({
                type: "jpeg",
                quality: 70,
              });
              return {
                text: `Screenshot of ${current.url()}`,
                images: [
                  { mimeType: "image/jpeg", data: image.toString("base64") },
                ],
              };
            }
            return {
              text: (await current.locator("body").ariaSnapshot()).slice(
                0,
                48000,
              ),
              data: { url: current.url() },
            };
          } finally {
            ctx.signal.removeEventListener("abort", abort);
          }
        },
      });
      return async () => {
        await browser?.close();
      };
    },
  };
}
