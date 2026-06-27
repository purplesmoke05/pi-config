import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const COMMAND_CODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
const COMMAND_CODE_OPENAI_BASE_URL = "https://api.commandcode.ai/provider/v1";
const COMMAND_CODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
const COMMAND_CODE_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 128000;
const COMMAND_CODE_MAX_TOKENS = 64000;

type Notice = {
	type: "info" | "warning" | "error";
	message: string;
};

type CommandCodeModelsResponse = {
	data?: Array<{
		id?: string;
		name?: string;
		context_length?: number;
	}>;
};

type CommandCodeModel = {
	id: string;
	name?: string;
	context_length?: number;
};

function zeroCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function uniqueSorted(values: string[]) {
	return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getCommandCodeApiKeyRef() {
	for (const name of ["CMD_API_KEY", "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]) {
		if (process.env[name]) return `$${name}`;
	}
	return "$CMD_API_KEY";
}

function getCommandCodeHeaders() {
	const zdr = process.env.CMD_ZDR?.toLowerCase();
	if (zdr === "1" || zdr === "true" || zdr === "yes") {
		return { "x-cmd-zdr": "1" };
	}
	return undefined;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		return (await response.json()) as T;
	} finally {
		clearTimeout(timeout);
	}
}

function formatFetchError(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function isCommandCodeAnthropicModel(id: string) {
	return id.toLowerCase().startsWith("claude-");
}

function isCommandCodeReasoningModel(id: string) {
	const lower = id.toLowerCase();
	return lower.startsWith("claude-") || lower.startsWith("gpt-5");
}

function buildCommandCodeModel(model: CommandCodeModel): ProviderModelConfig {
	const contextWindow = model.context_length ?? DEFAULT_CONTEXT_WINDOW;
	const anthropic = isCommandCodeAnthropicModel(model.id);
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: anthropic ? "anthropic-messages" : "openai-completions",
		baseUrl: anthropic ? COMMAND_CODE_ANTHROPIC_BASE_URL : COMMAND_CODE_OPENAI_BASE_URL,
		reasoning: isCommandCodeReasoningModel(model.id),
		input: ["text", "image"],
		cost: zeroCost(),
		contextWindow,
		maxTokens: Math.min(contextWindow, COMMAND_CODE_MAX_TOKENS),
	};
}

async function loadCommandCodeModels() {
	const payload = await fetchJson<CommandCodeModelsResponse>(COMMAND_CODE_MODELS_URL, COMMAND_CODE_FETCH_TIMEOUT_MS);
	return (payload.data ?? [])
		.filter((model): model is CommandCodeModel => typeof model.id === "string")
		.map(buildCommandCodeModel);
}

export default async function (pi: ExtensionAPI) {
	const notices: Notice[] = [];

	try {
		const models = await loadCommandCodeModels();
		if (models.length === 0) {
			notices.push({
				type: "warning",
				message: "provider-pack: Command Code returned no models; commandcode provider was not registered.",
			});
		} else {
			const headers = getCommandCodeHeaders();
			pi.registerProvider("commandcode", {
				name: "Command Code",
				baseUrl: COMMAND_CODE_OPENAI_BASE_URL,
				apiKey: getCommandCodeApiKeyRef(),
				api: "openai-completions",
				...(headers ? { headers } : {}),
				models,
			});
		}
	} catch (error) {
		notices.push({
			type: "error",
			message: `provider-pack: Command Code models could not be loaded; provider was not registered (${formatFetchError(error)}).`,
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const notice of notices) {
			ctx.ui.notify(notice.message, notice.type);
		}
	});
}
