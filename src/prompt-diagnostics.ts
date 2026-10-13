import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-commands";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { z } from "zod";
import { summarizeSdk } from "./prompt-metrics.ts";

const callable = (value: unknown) => typeof value === "function";
const rendererSchema = z.object({
	renderPrompt:
		z.custom<typeof import("@deepseek-ai/dsh-system-prompt").renderPrompt>(
			callable,
		),
	renderContextSnapshot:
		z.custom<
			typeof import("@deepseek-ai/dsh-system-prompt").renderContextSnapshot
		>(callable),
	renderContextSections:
		z.custom<
			typeof import("@deepseek-ai/dsh-system-prompt").renderContextSections
		>(callable),
});
const agentSchema = z.object({
	agentEvents:
		z.custom<typeof import("@deepseek-ai/dsh-agent").agentEvents>(callable),
});
const sessionsSchema = z.object({
	SessionId: z.custom<(value: string) => SessionId>(callable),
});

function measureAssembly(
	assembly: PromptAssembly,
	renderers: z.infer<typeof rendererSchema>,
) {
	const system = renderers.renderPrompt(assembly);
	const runtime = renderers.renderContextSnapshot(assembly);
	const sections = assembly.sections
		.map((section) => ({
			name: section.name,
			chars: renderers.renderPrompt({ ...assembly, sections: [section] })
				.length,
		}))
		.filter((section) => section.chars > 0)
		.sort((left, right) => right.chars - left.chars);
	const contexts = renderers
		.renderContextSections(assembly)
		.map((context) => ({ name: context.name, chars: context.text.length }))
		.sort((left, right) => right.chars - left.chars);
	const sdk =
		assembly.sections.find((section) => section.name === "tools:sdk")?.text ??
		"";
	return {
		systemChars: system.length,
		runtimeChars: runtime.length,
		nativeToolCount: assembly.tools.length,
		nativeToolSchemaJsonChars: JSON.stringify(assembly.tools).length,
		sections,
		contexts,
		sdk: summarizeSdk(sdk),
	};
}

async function inspectPrompt(
	ctx: Context,
	target: Agent,
	ready: (agent: Agent) => Promise<void>,
	signal: AbortSignal,
) {
	await ready(target);
	const api = agentSchema.parse(
		await ctx.loader.import("@deepseek-ai/dsh-agent"),
	);
	const decision = await api
		.agentEvents(ctx, target)
		.waterfall(
			"agent/pre-step",
			{ messages: [], turn: 1, step: 1, signal },
			async () => ({ kind: "enter", messages: [] }),
		);
	if (decision.kind !== "enter")
		throw new Error("Initial prompt preparation was rejected");
	if (target.status !== "idle" || target.inbox.nextTurn.length > 0)
		throw new Error("Prompt measurement must not start an Agent driver");
	const prepared = new Map(
		[...decision.messages, ...target.inbox.nextStep].map((message) => [
			message.id,
			message,
		]),
	);
	const reminders = [...prepared.values()].map((message) => ({
		source: message.source.kind,
		chars: message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("").length,
	}));
	const renderers = rendererSchema.parse(
		await ctx.loader.import("@deepseek-ai/dsh-system-prompt"),
	);
	const assembly = await ctx.systemPrompt.assemble({
		scope: target,
		agent: target,
		signal,
	});
	const measured = measureAssembly(assembly, renderers);
	const reminderChars = reminders.reduce(
		(total, reminder) => total + reminder.chars,
		0,
	);
	return {
		provider: target.options.provider,
		model: target.options.model,
		cwd: target.session.header.cwd,
		unit: "UTF-16 code units",
		preparation: "entered pre-step hooks; Agent driver remained idle",
		...measured,
		reminders,
		reminderChars,
		initialTextChars:
			measured.systemChars + measured.runtimeChars + reminderChars,
		modelRequests: 0,
		exclusions: [
			"conversation history",
			"user task",
			"tool results",
			"provider wire wrappers",
			"model-specific tokenization",
		],
	};
}

async function measureRoute(
	ctx: Context,
	owner: Agent,
	provider: string | undefined,
	ready: (agent: Agent) => Promise<void>,
	signal: AbortSignal,
) {
	const selectedProvider = provider ?? owner.options.provider;
	const model = provider
		? (await ctx.llm.listModels(provider))[0]?.id
		: owner.options.model;
	if (!model)
		throw new Error(
			"The selected provider advertises no model for measurement",
		);
	const sessions = sessionsSchema.parse(
		await ctx.loader.import("@deepseek-ai/dsh-session"),
	);
	const target = await ctx.agents.create({
		sessionId: sessions.SessionId(
			`orchestrator-measure-${crypto.randomUUID()}`,
		),
		meta: {
			agentPreset: "ptc-orchestrator",
			...(owner.session.header.cwd ? { cwd: owner.session.header.cwd } : {}),
		},
		agentOptions: {
			model,
			...(selectedProvider ? { provider: selectedProvider } : {}),
		},
		setup: (targetCtx) => {
			ctx.agentPresets.composeFrom(targetCtx, owner.ctx);
		},
	});
	try {
		return await inspectPrompt(ctx, target.agent, ready, signal);
	} finally {
		await target.dispose();
	}
}

export function registerPromptDiagnostics(
	ctx: Context,
	ready: (agent: Agent) => Promise<void>,
) {
	return ctx.inject(
		[
			"commands",
			"agents",
			"agentPresets",
			"tools",
			"systemPrompt",
			"loader",
			"llm",
		],
		(inner) => {
			inner.commands.register({
				name: "orchestrator-prompt",
				description:
					"Measure rendered prompt and PTC SDK sizes without calling a model",
				handler: async ({ agent, rawInput, signal }) => {
					const provider = rawInput.trim() || undefined;
					if (provider?.includes(" "))
						return {
							kind: "error",
							text: "Usage: /orchestrator-prompt [provider-id]",
						};
					const result = await measureRoute(
						inner,
						agent,
						provider,
						ready,
						signal,
					);
					return { kind: "success", text: JSON.stringify(result) };
				},
			});
		},
	);
}
