import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Starter extension. Replace or copy this directory when adding a new one.
// Test standalone: pi -e ./extensions/hello/index.ts
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("pi-config loaded", "info");
	});

	pi.registerTool({
		name: "greet",
		label: "Greet",
		description: "Greet someone by name",
		parameters: Type.Object({
			name: Type.String({ description: "Name to greet" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});

	pi.registerCommand("hello", {
		description: "Say hello from pi-config",
		handler: async (args, ctx) => {
			ctx.ui.notify(`Hello ${args || "world"}!`, "info");
		},
	});
}
