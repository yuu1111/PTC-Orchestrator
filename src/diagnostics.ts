import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-commands";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { z } from "zod";

const probe =
	"const methods = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']; const reasons = []; for (const method of methods) { try { await tools[method](method === 'read_mcp_resource' ? {server:'cloudflare',uri:'fixture://blocked'} : {server:'cloudflare'}); reasons.push('NOT BLOCKED'); } catch (error) { reasons.push(String(error)); } } return {blocked:reasons.filter(reason=>reason.includes('PTC-Orchestrator permits only')).length,reasons};";

async function inspectAgent(
	inner: Context,
	target: Agent,
	ready: (agent: Agent) => Promise<void>,
	signal: AbortSignal,
) {
	const llm = z
		.object({
			ToolCallId: z.custom<(value: string) => ToolCallId>(
				(value) => typeof value === "function",
			),
		})
		.parse(await inner.loader.import("@deepseek-ai/dsh-llm"));
	await ready(target);
	const assembly = await inner.systemPrompt.assemble({
		scope: target,
		agent: target,
		signal,
	});
	const sdk =
		assembly.sections.find((section) => section.name === "tools:sdk")?.text ??
		"";
	const names = [...new Set(sdk.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])];
	const idaTools = names.filter((tool) =>
		tool.startsWith("mcp__idalib__"),
	).length;
	const foreignTools = names.filter(
		(tool) => !tool.startsWith("mcp__idalib__"),
	).length;
	const foreignInstructions = assembly.sections.filter(
		(section) =>
			section.name.startsWith("mcp:") &&
			section.name !== "mcp:idalib" &&
			section.text.trim().length > 0,
	).length;
	const inventory =
		assembly.sections.find((section) => section.name === "mcp-resource-servers")
			?.text ?? "";
	const result = await inner.tools.execute({
		callId: llm.ToolCallId(crypto.randomUUID()),
		name: "run_code",
		arguments: {
			code: probe,
			description: "Verify excluded MCP resource operations are blocked",
		},
		agent: target,
		signal,
	});
	if (result.isError) throw new Error("PTC resource-denial probe failed");
	const value = z
		.object({ result: z.object({ blocked: z.number() }) })
		.parse(result.value);
	const idaOnlyInventory = inventory.includes('server: "idalib" only');
	return {
		sessionId: target.id,
		idaTools,
		foreignTools,
		foreignInstructions,
		idaOnlyInventory,
		blockedResources: value.result.blocked,
		passed:
			idaTools > 0 &&
			foreignTools === 0 &&
			foreignInstructions === 0 &&
			idaOnlyInventory &&
			value.result.blocked === 3,
	};
}

async function inspectChild(
	inner: Context,
	agent: Agent,
	ready: (agent: Agent) => Promise<void>,
	signal: AbortSignal,
) {
	const sessions = z
		.object({
			SessionId: z.custom<(value: string) => SessionId>(
				(value) => typeof value === "function",
			),
		})
		.parse(await inner.loader.import("@deepseek-ai/dsh-session"));
	const child = await inner.agents.create({
		sessionId: sessions.SessionId(crypto.randomUUID()),
		parentAgent: agent,
		meta: {
			origin: "subagent",
			parentSession: agent.id,
			agentPreset: "ptc-orchestrator",
			...(agent.session.header.cwd ? { cwd: agent.session.header.cwd } : {}),
		},
		agentOptions: agent.options,
		setup: (childCtx) => {
			inner.agentPresets.composeFrom(childCtx, agent.ctx);
		},
	});
	try {
		return await inspectAgent(inner, child.agent, ready, signal);
	} finally {
		await child.dispose();
	}
}

async function inspectControl(
	inner: Context,
	agent: Agent,
	signal: AbortSignal,
) {
	const sessions = z
		.object({
			SessionId: z.custom<(value: string) => SessionId>(
				(value) => typeof value === "function",
			),
		})
		.parse(await inner.loader.import("@deepseek-ai/dsh-session"));
	const control = await inner.agents.create({
		sessionId: sessions.SessionId(crypto.randomUUID()),
		meta: {
			agentPreset: "ptc",
			...(agent.session.header.cwd ? { cwd: agent.session.header.cwd } : {}),
		},
		agentOptions: agent.options,
		setup: async (controlCtx) => {
			await inner.agentPresets.mount(controlCtx, "ptc");
		},
	});
	try {
		const assembly = await inner.systemPrompt.assemble({
			scope: control.agent,
			agent: control.agent,
			signal,
		});
		const sdk =
			assembly.sections.find((section) => section.name === "tools:sdk")?.text ??
			"";
		const names = [...new Set(sdk.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort();
		const expected = inner.tools
			.schemas()
			.map((tool) => tool.name)
			.filter((tool) => tool.startsWith("mcp__"))
			.sort();
		return {
			preset: "ptc",
			cloudflareTools: names.filter((tool) =>
				tool.startsWith("mcp__cloudflare__"),
			).length,
			idaTools: names.filter((tool) => tool.startsWith("mcp__idalib__")).length,
			matchesHostMcp: JSON.stringify(names) === JSON.stringify(expected),
		};
	} finally {
		await control.dispose();
	}
}

export function registerDiagnostics(
	ctx: Context,
	ready: (agent: Agent) => Promise<void>,
) {
	ctx.inject(
		["commands", "agents", "agentPresets", "tools", "systemPrompt", "loader"],
		(inner) => {
			inner.commands.register({
				name: "orchestrator-check",
				description:
					"Verify IDA-only MCP exposure without requesting a model response",
				handler: async ({ agent, rawInput, signal }) => {
					const option = rawInput.trim();
					if (option !== "" && option !== "child")
						return {
							kind: "error",
							text: "Usage: /orchestrator-check [child]",
						};
					const parent = await inspectAgent(inner, agent, ready, signal);
					if (option === "")
						return {
							kind: parent.passed ? "success" : "error",
							text: JSON.stringify({ parent }),
						};
					const childResult = await inspectChild(inner, agent, ready, signal);
					const control = await inspectControl(inner, agent, signal);
					return {
						kind:
							parent.passed && childResult.passed && control.matchesHostMcp
								? "success"
								: "error",
						text: JSON.stringify({
							parent,
							child: childResult,
							control,
							childKind: "idle native Agent; no delegated model task",
							modelRequests: 0,
						}),
					};
				},
			});
		},
	);
}
