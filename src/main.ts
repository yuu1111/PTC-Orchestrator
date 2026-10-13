import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ScopeKey } from "@deepseek-ai/dsh-scope";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { registerDiagnostics } from "./diagnostics.ts";
import { registerPromptDiagnostics } from "./prompt-diagnostics.ts";

export const name = "ptc-orchestrator-ida-only";
export const inject = ["agents", "loader", "tools", "systemPrompt"];
export const Config = z.object({
	sourceEntry: z.string().default("include:mcp-idalib"),
});

type Settings = z.infer<typeof Config>;

const resources = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);
const scopeApiSchema = z.object({
	scopeOf: z.custom<(ctx: Context) => ScopeKey | undefined>(
		(value) => typeof value === "function",
	),
	scopeChainOf: z.custom<(key: ScopeKey | undefined) => ScopeKey[]>(
		(value) => typeof value === "function",
	),
});
const reconnectSchema = z
	.object({
		enabled: z.boolean(),
		initialDelayMs: z.number(),
		maxDelayMs: z.number(),
		maxAttempts: z.number(),
	})
	.optional();
const connectionFields = {
	serverName: z.literal("idalib"),
	toolCallTimeoutMs: z.number(),
	failOnStartupError: z.boolean(),
	maxInstructionBytes: z.number().optional(),
	reconnect: reconnectSchema,
};
const connectionSchema = z.discriminatedUnion("transport", [
	z.object({
		...connectionFields,
		transport: z.literal("streamable-http"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()),
	}),
	z.object({
		...connectionFields,
		transport: z.literal("stdio"),
		command: z.string().min(1),
		args: z.array(z.string()),
		env: z.record(z.string(), z.string()),
		cwd: z.string(),
	}),
]);

export async function installAgentPolicy(
	ctx: Context,
	inheritedScope: ScopeKey,
	settings: Settings,
) {
	const scopes = scopeApiSchema.parse(
		await ctx.loader.import("@deepseek-ai/dsh-scope"),
	);
	const key = scopes.scopeOf(ctx);
	if (key === undefined) throw new Error("IDA policy requires an Agent scope");
	let disposed = false;
	let mask: (() => void) | undefined;
	let signature: string | undefined;
	let refreshing = false;
	const shadows = new Map<string, () => void>();
	let promptTask: Promise<void> | undefined;
	let connectionReady = false;

	const refreshTools = () => {
		if (disposed || refreshing) return;
		const allow = ctx.tools
			.schemas(inheritedScope)
			.map((tool) => tool.name)
			.filter((tool) => !tool.startsWith("mcp__") && tool !== "run_code")
			.sort();
		const next = JSON.stringify(allow);
		if (next === signature) return;
		refreshing = true;
		try {
			mask?.();
			mask = ctx.tools.restrict({ allow });
			signature = next;
		} finally {
			refreshing = false;
		}
	};

	const refreshPrompts = (): Promise<void> => {
		if (disposed) return Promise.resolve();
		if (promptTask) return promptTask;
		promptTask = Promise.resolve()
			.then(async () => {
				const assembly = await ctx.systemPrompt.assemble({
					scope: inheritedScope,
				});
				for (const section of assembly.sections) {
					if (disposed) return;
					if (
						!section.name.startsWith("mcp:") ||
						section.name === "mcp:idalib" ||
						shadows.has(section.name)
					)
						continue;
					shadows.set(
						section.name,
						ctx.systemPrompt.section({
							name: section.name,
							order: 9000,
							interpolate: false,
							text: "",
						}),
					);
				}
			})
			.finally(() => {
				promptTask = undefined;
			});
		return promptTask;
	};

	ctx.effect(() => async () => {
		disposed = true;
		await promptTask;
		mask?.();
		for (const remove of shadows.values()) remove();
	});
	ctx.tools.guard((execution) => {
		if (resources.has(execution.name)) {
			const requested = z
				.object({ server: z.literal("idalib") })
				.safeParse(execution.arguments);
			if (!connectionReady || !requested.success)
				return "PTC-Orchestrator permits only its configured IDA MCP resources";
		}
		if (execution.name.startsWith("mcp__")) {
			const inherited = ctx.tools.get(execution.name, inheritedScope);
			const visible = ctx.tools.get(execution.name, key);
			if (
				!connectionReady ||
				!visible ||
				visible === inherited ||
				!execution.name.startsWith("mcp__idalib__")
			)
				return "Inherited MCP tools are unavailable in PTC-Orchestrator";
		}
		return undefined;
	});
	refreshTools();
	ctx.on("tools/change", refreshTools);
	ctx.on("system-prompt/change", () => refreshPrompts());
	ctx.systemPrompt.section({
		name: "mcp-resource-servers",
		order: 9000,
		interpolate: false,
		text: () =>
			connectionReady
				? '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with server: "idalib" only.'
				: "",
	});
	await refreshPrompts();

	const source = ctx.loader.resolve(settings.sourceEntry);
	const config = connectionSchema.parse(source.fiber?.config);
	const runtime = source.fiber?.runtime;
	if (source.disabled || !runtime || source.fiber?.state !== 2)
		throw new Error("Configured Host IDA MCP entry is not active");
	const client = z
		.custom<Plugin>(
			(value) =>
				typeof value === "function" ||
				(typeof value === "object" &&
					value !== null &&
					"apply" in value &&
					typeof value.apply === "function"),
		)
		.parse(await ctx.loader.import(source.options.name));
	const connection = ctx.plugin(client, config);
	await connection.await();
	if (connection.state !== 2)
		throw new Error("Agent-local IDA MCP client failed to activate");
	connectionReady = true;
	return async () => {
		refreshTools();
		await refreshPrompts();
		if (connection.state !== 2)
			throw new Error("Agent-local IDA MCP client is unavailable");
	};
}

export async function apply(ctx: Context, settings: Settings) {
	const scopes = scopeApiSchema.parse(
		await ctx.loader.import("@deepseek-ai/dsh-scope"),
	);
	const composition = scopes.scopeOf(ctx);
	if (composition === undefined)
		throw new Error("IDA policy belongs inside an Agent preset");
	const installations = new Map<
		Agent,
		{ fiber: Fiber; refresh?: () => Promise<void> }
	>();
	const ensure = (agent: Agent) => {
		if (!scopes.scopeChainOf(scopes.scopeOf(agent.ctx)).includes(composition))
			return undefined;
		const existing = installations.get(agent);
		if (existing) return existing;
		const state: { fiber: Fiber; refresh?: () => Promise<void> } = {
			fiber: agent.ctx.plugin({
				name: "agent-ida-policy",
				inject: ["loader", "tools", "systemPrompt"],
				apply: async (agentCtx: Context) => {
					state.refresh = await installAgentPolicy(
						agentCtx,
						composition,
						settings,
					);
				},
			}),
		};
		installations.set(agent, state);
		return state;
	};
	ctx.effect(() => async () => {
		await Promise.all(
			[...installations.values()].map((state) => state.fiber.dispose()),
		);
		installations.clear();
	});
	ctx.on("agent/created", async ({ agent }) => {
		await ensure(agent)?.fiber.await();
	});
	ctx.on("agent/disposed", ({ agent }) => {
		installations.delete(agent);
	});
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const state = ensure(agent);
		if (state) {
			await state.fiber.await();
			if (state.fiber.state !== 2 || !state.refresh)
				throw new Error("IDA-only MCP policy is not ready");
			await state.refresh();
		}
		return next();
	});
	const ready = async (agent: Agent) => {
		const state = ensure(agent);
		if (!state)
			throw new Error("Agent does not belong to this preset revision");
		await state.fiber.await();
		if (state.fiber.state !== 2 || !state.refresh)
			throw new Error("IDA-only MCP policy is not ready");
		await state.refresh();
	};
	registerDiagnostics(ctx, ready);
	registerPromptDiagnostics(ctx, ready);
	for (const agent of ctx.agents.list()) await ensure(agent)?.fiber.await();
}
