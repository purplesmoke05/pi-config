/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with dynamically discovered models.
 *
 * @see https://github.com/mario-gc/pi-ollama-cloud-provider
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { discoverModels } from "./discovery.js";
import { buildMainMenu } from "./menu.js";

export default async function (pi: ExtensionAPI) {
  // Register provider on startup (uses cache if available)
  await discoverModels(pi);

  // Interactive menu command
  pi.registerCommand("ollama-cloud", {
    description: "Ollama Cloud management menu",
    handler: async (_args: string, ctx) => {
      const settingsTheme = getSettingsListTheme();

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let current = buildMainMenu(
          pi,
          theme,
          settingsTheme,
          ctx.ui.notify.bind(ctx.ui),
          ctx.ui.setWorkingMessage.bind(ctx.ui),
          () => { done(undefined as never); },
          (next) => { current = next; },
        );

        return {
          render(width: number) {
            return current.render(width);
          },
          invalidate() {
            current.invalidate();
          },
          handleInput(data: string) {
            current.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
