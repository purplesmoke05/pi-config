/**
 * Interactive TUI menu for the /ollama-cloud command.
 *
 * Uses SettingsList from @earendil-works/pi-tui for native pi menu behavior.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { discoverModels, registerProvider, OLLAMA_BASE } from "./discovery.js";
import { readCache, getCacheInfo, type ModelSource } from "./cache.js";

type SubmenuDone = (selectedValue?: string) => void;

// --- Status submenu ---

function buildStatusSubmenu(
  settingsTheme: ReturnType<typeof getSettingsListTheme>,
  modelCount: number,
  sources: Record<ModelSource, number>,
  done: () => void,
): Component {
  const isOffline = process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
  const cacheInfo = getCacheInfo();

  const sourceLabels: Record<ModelSource, string> = {
    ollama: "Ollama API",
    modelsdev: "models.dev",
    inference: "inference",
  };

  const sourceItems: SettingItem[] = Object.entries(sources)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({
      id: `src_${key}`,
      label: sourceLabels[key as ModelSource],
      currentValue: String(count),
      values: [String(count)],
      description: `${count} model${count > 1 ? "s" : ""} sourced from ${sourceLabels[key as ModelSource]}`,
    }));

  const items: SettingItem[] = [
    {
      id: "mode",
      label: "Mode",
      currentValue: isOffline ? "Offline" : "Online",
      values: [isOffline ? "offline" : "online"],
      description: isOffline
        ? "PI_OFFLINE=1 — no network calls; using cached data only"
        : "Online — normal operation with live API calls",
    },
    {
      id: "models",
      label: "Registered Models",
      currentValue: String(modelCount),
      values: [String(modelCount)],
      description: `Total models registered from Ollama Cloud API`,
    },
    ...sourceItems,
    {
      id: "endpoint",
      label: "API Endpoint",
      currentValue: OLLAMA_BASE,
      values: [OLLAMA_BASE],
      description: "Ollama Cloud API base URL",
    },
    {
      id: "cache",
      label: "Cache",
      currentValue: cacheInfo.exists ? `Age: ${cacheInfo.age}` : "Not found",
      values: [cacheInfo.exists ? "hit" : "miss"],
      description: cacheInfo.exists
        ? `Cached ${cacheInfo.modelCount} models, ${cacheInfo.size}`
        : "No cache file — models fetched fresh",
    },
    {
      id: "ttl",
      label: "Cache TTL",
      currentValue: "1 hour",
      values: ["1 hour"],
      description: "Cache expires after 1 hour from last refresh",
    },
  ];

  return new SettingsList(
    items,
    Math.min(items.length + 2, 10),
    settingsTheme,
    () => {},
    done,
  );
}

// --- Refresh submenu ---

function buildRefreshSubmenu(
  pi: ExtensionAPI,
  tuiTheme: Theme,
  settingsTheme: ReturnType<typeof getSettingsListTheme>,
  notify: ExtensionCommandContext["ui"]["notify"],
  setWorkingMessage: ExtensionCommandContext["ui"]["setWorkingMessage"],
  subDone: () => void,
  onRebuild: (comp: Component) => void,
): Component {
  const items: SettingItem[] = [
    {
      id: "ollama",
      label: "From Ollama API",
      currentValue: "→",
      values: ["→"],
      description: "Fetch /api/show for all models, fallback to models.dev if needed",
    },
    {
      id: "modelsdev",
      label: "From models.dev",
      currentValue: "→",
      values: ["→"],
      description: "Bypass /api/show, use models.dev metadata directly",
    },
  ];

  return new SettingsList(
    items,
    4,
    settingsTheme,
    async (id: string) => {
      // Offline guard — should not be reachable, but handle defensively
      if (process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true") {
        notify("Cannot refresh: offline mode", "error");
        subDone();
        onRebuild(
          buildMainMenu(pi, tuiTheme, settingsTheme, notify, setWorkingMessage, () => {}, onRebuild),
        );
        return;
      }
      setWorkingMessage("Refreshing Ollama Cloud models...");
      const mode = id === "modelsdev" ? "modelsdev" : "ollama";
      const result = await discoverModels(pi, { force: true, mode });
      setWorkingMessage();
      subDone();
      onRebuild(
        buildMainMenu(pi, tuiTheme, settingsTheme, notify, setWorkingMessage, () => {}, onRebuild),
      );
      if (result.error) {
        notify(`Refresh failed: ${result.error}`, "error");
      } else {
        const sourceSummary = Object.entries(result.sources)
          .filter(([, count]) => count > 0)
          .map(([key, count]) => `${count} ${key}`)
          .join(", ");
        notify(`Registered ${result.count} models (${sourceSummary})`, "info");
      }
    },
    () => {},
  );
}

// --- Main menu ---

export function buildMainMenu(
  pi: ExtensionAPI,
  tuiTheme: Theme,
  settingsTheme: ReturnType<typeof getSettingsListTheme>,
  notify: ExtensionCommandContext["ui"]["notify"],
  setWorkingMessage: ExtensionCommandContext["ui"]["setWorkingMessage"],
  done: () => void,
  onRebuild: (comp: Component) => void,
): Component {
  const isOffline = process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
  const cacheInfo = getCacheInfo();
  const cached = readCache();
  const modelCount = cached ? cached.models.length : 0;
  const sources = cached ? cached.models.reduce(
    (acc, entry) => { acc[entry.source]++; return acc; },
    { ollama: 0, modelsdev: 0, inference: 0 } as Record<ModelSource, number>,
  ) : { ollama: 0, modelsdev: 0, inference: 0 };

  const refreshItem: SettingItem = isOffline
    ? {
        id: "refresh",
        label: "Refresh Models",
        currentValue: "Unavailable",
        values: ["unavailable"],
        description: "Offline mode — network calls are disabled",
      }
    : {
        id: "refresh",
        label: "Refresh Models",
        currentValue: "submenu",
        description: "Update model list from Ollama API or models.dev",
        submenu: (_currentValue: string, subDone: SubmenuDone) =>
          buildRefreshSubmenu(pi, tuiTheme, settingsTheme, notify, setWorkingMessage, subDone, (_next) => {
            onRebuild(
              buildMainMenu(pi, tuiTheme, settingsTheme, notify, setWorkingMessage, done, onRebuild),
            );
          }),
      };

  const items: SettingItem[] = [
    refreshItem,
    {
      id: "status",
      label: "Status",
      currentValue: "submenu",
      description: "View connection info, source breakdown, and cache status",
      submenu: (_currentValue: string, subDone: SubmenuDone) =>
        buildStatusSubmenu(settingsTheme, modelCount, sources, () => {
          subDone();
          onRebuild(
            buildMainMenu(pi, tuiTheme, settingsTheme, notify, setWorkingMessage, done, onRebuild),
          );
        }),
    },
    {
      id: "cache_info",
      label: "Cache Info",
      currentValue: cacheInfo.exists ? `${cacheInfo.age} ago` : (isOffline ? "Not cached" : "Empty"),
      values: [cacheInfo.exists ? "hit" : "miss"],
      description: isOffline
        ? (cacheInfo.exists
            ? `Offline mode — using cached data regardless of TTL`
            : `Offline mode — no cached data available; models may not load`)
        : (cacheInfo.exists
            ? `${cacheInfo.modelCount} models cached, ${cacheInfo.size}`
            : "No cache — will fetch fresh on next discovery"),
    },
  ];

  const container = new Container();
  container.addChild(
    new (class {
      render(_width: number) {
        const title = isOffline ? tuiTheme.fg("accent", tuiTheme.bold("Ollama Cloud (offline)")) : tuiTheme.fg("accent", tuiTheme.bold("Ollama Cloud"));
        return [title, ""];
      }
      invalidate() {}
    })(),
  );

  let currentList: SettingsList;

  function buildList(): SettingsList {
    return new SettingsList(
      items,
      Math.min(items.length + 2, 8),
      settingsTheme,
      () => {},
      done,
    );
  }

  currentList = buildList();
  container.addChild(currentList);

  return {
    render(width: number) {
      return container.render(width);
    },
    invalidate() {
      container.invalidate();
    },
    handleInput(data: string) {
      currentList.handleInput(data);
    },
  };
}
