import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import McpResources from "@deepseek-ai/dsh-mcp-resources";
import { createScope, type ScopeKey, scopeOf } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { installAgentPolicy } from "../src/ida-only.ts";

const connectionConfig = {
	serverName: "idalib",
	transport: "streamable-http",
	url: "https://fixture.invalid/mcp",
	headers: {},
	toolCallTimeoutMs: 1000,
	failOnStartupError: true,
};

function tool(
	name: string,
	execute: () => Promise<unknown> = async () => name,
): ToolDefinition {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute,
		output: {
			schema: {},
			render: (value) => [{ type: "text", text: JSON.stringify(value) }],
		},
	};
}

// Runtime routing accepts opaque scope identities; the public caller type requires a complete Agent.
async function dispatch(
	ctx: Context,
	key: ScopeKey,
	name: string,
	args: unknown = {},
) {
	const result: unknown = await Reflect.apply(ctx.tools.execute, ctx.tools, [
		{
			callId: "fixture-call",
			name,
			arguments: args,
			agent: key,
			signal: new AbortController().signal,
		},
	]);
	return z
		.object({ isError: z.boolean(), content: z.array(z.unknown()) })
		.parse(result);
}

async function fixture(options: { failLocal?: boolean } = {}) {
	const ctx = new Context();
	const services = [
		ctx.plugin(Loader),
		ctx.plugin(ToolRuntime),
		ctx.plugin(SystemPrompt),
		ctx.plugin(McpResources),
	];
	await Promise.all(services.map((fiber) => fiber.await()));
	for (const fiber of services) assert.equal(fiber.state, 2);
	const clients: {
		ctx: Context;
		config: unknown;
		disposed: boolean;
		calls: string[];
	}[] = [];
	const Config = z.object({
		serverName: z.string(),
		transport: z.literal("streamable-http"),
		url: z.string(),
		headers: z.record(z.string(), z.string()),
		toolCallTimeoutMs: z.number(),
		failOnStartupError: z.boolean(),
	});
	const selected = {
		name: "fixture-selected-idalib",
		inject: ["tools", "systemPrompt", "mcpResources"],
		Config,
		apply(clientCtx: Context, config: z.infer<typeof Config>) {
			if (options.failLocal && scopeOf(clientCtx) !== undefined)
				throw new Error("Fixture client activation failed");
			const client: {
				ctx: Context;
				config: unknown;
				disposed: boolean;
				calls: string[];
			} = { ctx: clientCtx, config, disposed: false, calls: [] };
			clients.push(client);
			clientCtx.tools.register(
				tool("mcp__idalib__survey_binary", async () => {
					client.calls.push("tool");
					return { client: clients.indexOf(client) };
				}),
			);
			clientCtx.systemPrompt.section({
				name: "mcp:idalib",
				order: 100,
				text: "IDA fixture instructions",
			});
			clientCtx.mcpResources.register(config.serverName, {
				async request(request) {
					client.calls.push(request.method);
					return { client: clients.indexOf(client), method: request.method };
				},
			});
			clientCtx.effect(() => () => {
				client.disposed = true;
			});
		},
	};
	ctx.loader.builtins["fixture-idalib"] = selected;
	await ctx.loader.root.update([
		{
			id: "fixture-idalib",
			name: "cordis:fixture-idalib",
			config: connectionConfig,
		},
	]);
	await ctx.loader.await();
	assert.equal(
		ctx.loader.resolve("fixture-idalib").fiber?.state,
		2,
		ctx.logger.buffer.map((message) => message.args.join(" ")).join("\n"),
	);
	assert.equal(clients.length, 1);
	const cloudflareCalls: string[] = [];
	ctx.tools.register(
		tool("mcp__cloudflare__execute", async () => {
			cloudflareCalls.push("tool");
			return "cloudflare";
		}),
	);
	ctx.tools.register(tool("mcp__idalib__other__execute"));
	ctx.tools.register(tool("mcp__other__execute"));
	ctx.tools.register(tool("native_before"));
	ctx.mcpResources.register("cloudflare", {
		async request(request) {
			cloudflareCalls.push(request.method);
			return { server: "cloudflare" };
		},
	});
	ctx.systemPrompt.section({
		name: "mcp:cloudflare",
		order: 101,
		text: "Cloudflare inherited instructions",
	});
	const owner = ctx.plugin({
		name: "fixture-policy-owner",
		inject: ["loader", "tools", "systemPrompt", "mcpResources"],
		apply: () => undefined,
	});
	await owner.await();
	assert.equal(owner.state, 2);
	const composition = {};
	const preset = createScope(owner.ctx, composition);
	const agentKey = {};
	const agent = createScope(preset.ctx, agentKey, { parent: composition });
	const siblingKey = {};
	const sibling = createScope(preset.ctx, siblingKey, { parent: composition });
	const otherKey = {};
	const other = createScope(ctx, otherKey);
	const policy = createScope(agent.ctx, agentKey);
	return {
		ctx,
		clients,
		cloudflareCalls,
		composition,
		preset,
		agentKey,
		agent,
		siblingKey,
		sibling,
		otherKey,
		other,
		policy,
		install: () =>
			installAgentPolicy(policy.ctx, composition, {
				sourceEntry: "fixture-idalib",
			}),
		async dispose() {
			await policy.dispose();
			await agent.dispose();
			await sibling.dispose();
			await other.dispose();
			await preset.dispose();
			await ctx.fiber.dispose();
		},
	};
}

async function prompt(ctx: Context, key: ScopeKey) {
	return (await ctx.systemPrompt.assemble({ scope: key })).sections
		.map((section) => section.text)
		.join("\n");
}

function names(ctx: Context, key: ScopeKey) {
	return ctx.tools
		.schemas(key)
		.map((schema) => schema.name)
		.sort();
}

test("Agent uses the selected source runtime in its own scope while other presets retain Cloudflare", async () => {
	const f = await fixture();
	try {
		await f.install();
		assert.equal(f.clients.length, 2);
		const host = f.clients[0];
		const local = f.clients[1];
		assert.ok(host && local);
		assert.equal(scopeOf(host.ctx), undefined);
		assert.equal(scopeOf(local.ctx), f.agentKey);
		assert.deepEqual(local.config, connectionConfig);
		assert.notEqual(local.config, host.config);
		assert.equal(
			(await dispatch(f.ctx, f.agentKey, "mcp__idalib__survey_binary")).isError,
			false,
		);
		assert.deepEqual(local.calls, ["tool"]);
		assert.deepEqual(host.calls, []);
		for (const name of [
			"mcp__cloudflare__execute",
			"mcp__idalib__other__execute",
			"mcp__other__execute",
		]) {
			assert.ok(!names(f.ctx, f.agentKey).includes(name));
			assert.equal((await dispatch(f.ctx, f.agentKey, name)).isError, true);
		}
		assert.ok(names(f.ctx, f.otherKey).includes("mcp__cloudflare__execute"));
		assert.equal(
			(await dispatch(f.ctx, f.otherKey, "mcp__cloudflare__execute")).isError,
			false,
		);
		assert.deepEqual(f.cloudflareCalls, ["tool"]);
	} finally {
		await f.dispose();
	}
});

test("Resource tools accept exactly idalib and reject other server arguments before provider invocation", async () => {
	const f = await fixture();
	try {
		await f.install();
		const local = f.clients[1];
		assert.ok(local);
		for (const name of [
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		]) {
			for (const server of [
				"cloudflare",
				"idalib__other",
				"IDALIB",
				" idalib",
				undefined,
			]) {
				assert.equal(
					(
						await dispatch(f.ctx, f.agentKey, name, {
							server,
							uri: "fixture://resource",
						})
					).isError,
					true,
				);
			}
			assert.deepEqual(f.cloudflareCalls, []);
			assert.equal(
				(
					await dispatch(f.ctx, f.agentKey, name, {
						server: "idalib",
						uri: "fixture://resource",
					})
				).isError,
				false,
			);
		}
		assert.deepEqual(local.calls, [
			"resources/list",
			"resources/templates/list",
			"resources/read",
		]);
		assert.deepEqual(f.clients[0]?.calls, []);
		assert.equal(
			(
				await dispatch(f.ctx, f.otherKey, "list_mcp_resources", {
					server: "cloudflare",
				})
			).isError,
			false,
		);
		assert.deepEqual(f.cloudflareCalls, ["resources/list"]);
	} finally {
		await f.dispose();
	}
});

test("Inherited MCP instructions and server inventory are shadowed only inside the Agent", async () => {
	const f = await fixture();
	try {
		await f.install();
		const ownPrompt = await prompt(f.ctx, f.agentKey);
		assert.match(ownPrompt, /IDA fixture instructions/);
		assert.match(ownPrompt, /server: "idalib" only/);
		assert.doesNotMatch(ownPrompt, /Cloudflare|cloudflare/);
		const otherPrompt = await prompt(f.ctx, f.otherKey);
		assert.match(otherPrompt, /Cloudflare inherited instructions/);
		assert.match(otherPrompt, /cloudflare/);
	} finally {
		await f.dispose();
	}
});

test("Refresh retains new native tools, hides late inherited MCP tools and prompts, and does not recurse", async () => {
	const f = await fixture();
	try {
		const refresh = await f.install();
		let changes = 0;
		f.ctx.on("tools/change", () => {
			changes += 1;
			assert.ok(
				changes < 40,
				"refresh must not recursively register restrictions",
			);
		});
		const removeNative = f.ctx.tools.register(tool("native_late"));
		const removePresetNative = f.preset.ctx.tools.register(
			tool("preset_native_late"),
		);
		f.preset.ctx.tools.register(tool("mcp__preset_late__execute"));
		const inheritedTool = f.ctx.tools.register(tool("mcp__late__execute"));
		f.ctx.systemPrompt.section({
			name: "mcp:late",
			order: 102,
			text: "Late inherited MCP instructions",
		});
		const local = f.clients[1];
		assert.ok(local);
		local.ctx.tools.register(tool("mcp__idalib__late"));
		await refresh();
		assert.ok(names(f.ctx, f.agentKey).includes("native_late"));
		assert.ok(names(f.ctx, f.agentKey).includes("preset_native_late"));
		assert.ok(!names(f.ctx, f.agentKey).includes("mcp__preset_late__execute"));
		assert.ok(names(f.ctx, f.agentKey).includes("mcp__idalib__late"));
		assert.ok(!names(f.ctx, f.agentKey).includes("mcp__late__execute"));
		assert.equal(
			(await dispatch(f.ctx, f.agentKey, "mcp__idalib__late")).isError,
			false,
		);
		assert.equal(
			(await dispatch(f.ctx, f.agentKey, "mcp__late__execute")).isError,
			true,
		);
		assert.doesNotMatch(
			await prompt(f.ctx, f.agentKey),
			/Late inherited MCP instructions/,
		);
		assert.match(
			await prompt(f.ctx, f.otherKey),
			/Late inherited MCP instructions/,
		);
		removeNative();
		removePresetNative();
		inheritedTool();
		await refresh();
		assert.ok(!names(f.ctx, f.agentKey).includes("native_late"));
		const stable = changes;
		await Promise.all([refresh(), refresh(), refresh()]);
		assert.equal(changes, stable);
	} finally {
		await f.dispose();
	}
});

test("Sibling Agents receive independent clients and policy disposal restores inheritance without closing providers elsewhere", async () => {
	const f = await fixture();
	const siblingPolicy = createScope(f.sibling.ctx, f.siblingKey);
	try {
		await f.install();
		await installAgentPolicy(siblingPolicy.ctx, f.composition, {
			sourceEntry: "fixture-idalib",
		});
		assert.equal(f.clients.length, 3);
		assert.equal(scopeOf(f.clients[2]?.ctx ?? f.ctx), f.siblingKey);
		assert.equal(
			(await dispatch(f.ctx, f.siblingKey, "mcp__idalib__survey_binary"))
				.isError,
			false,
		);
		assert.deepEqual(f.clients[2]?.calls, ["tool"]);
		assert.deepEqual(f.clients[1]?.calls, []);
		await f.policy.dispose();
		assert.equal(f.clients[1]?.disposed, true);
		assert.equal(f.clients[0]?.disposed, false);
		assert.equal(f.clients[2]?.disposed, false);
		assert.ok(names(f.ctx, f.agentKey).includes("mcp__cloudflare__execute"));
		assert.match(
			await prompt(f.ctx, f.agentKey),
			/Cloudflare inherited instructions/,
		);
		assert.equal(
			(
				await dispatch(f.ctx, f.agentKey, "list_mcp_resources", {
					server: "cloudflare",
				})
			).isError,
			false,
		);
		assert.equal(
			(
				await dispatch(f.ctx, f.agentKey, "list_mcp_resources", {
					server: "idalib",
				})
			).isError,
			false,
		);
		assert.deepEqual(f.clients[0]?.calls, ["resources/list"]);
		assert.equal(
			(
				await dispatch(f.ctx, f.siblingKey, "list_mcp_resources", {
					server: "cloudflare",
				})
			).isError,
			true,
		);
		assert.equal(
			(
				await dispatch(f.ctx, f.siblingKey, "list_mcp_resources", {
					server: "idalib",
				})
			).isError,
			false,
		);
		assert.deepEqual(f.clients[2]?.calls, ["tool", "resources/list"]);
		await siblingPolicy.dispose();
		assert.equal(f.clients[2]?.disposed, true);
		assert.equal(f.clients[0]?.disposed, false);
	} finally {
		await siblingPolicy.dispose();
		await f.dispose();
	}
});

test("Own non-IDA MCP tools remain denied even though scoped registrations bypass inherited masks", async () => {
	const f = await fixture();
	try {
		await f.install();
		let calls = 0;
		f.agent.ctx.tools.register(
			tool("mcp__cloudflare__own", async () => {
				calls += 1;
				return "blocked";
			}),
		);
		assert.ok(names(f.ctx, f.agentKey).includes("mcp__cloudflare__own"));
		assert.equal(
			(await dispatch(f.ctx, f.agentKey, "mcp__cloudflare__own")).isError,
			true,
		);
		assert.equal(calls, 0);
	} finally {
		await f.dispose();
	}
});

test("Refresh fails closed before the next model step when the Agent-local client disappears", async () => {
	const f = await fixture();
	try {
		const refresh = await f.install();
		const local = f.clients[1];
		assert.ok(local);
		await local.ctx.fiber.dispose();
		assert.equal(local.disposed, true);
		let modelSteps = 0;
		await assert.rejects(async () => {
			await refresh();
			modelSteps += 1;
		}, /unavailable/);
		assert.equal(modelSteps, 0);
		assert.equal(f.clients[0]?.disposed, false);
	} finally {
		await f.dispose();
	}
});

test("Agent-local activation failure never advances the model step or exposes inherited MCP calls", async () => {
	const f = await fixture({ failLocal: true });
	try {
		let modelSteps = 0;
		await assert.rejects(async () => {
			await f.install();
			modelSteps += 1;
		}, /activation failed|failed to activate/);
		assert.equal(modelSteps, 0);
		assert.equal(f.clients.length, 1);
		assert.equal(
			(await dispatch(f.ctx, f.agentKey, "mcp__cloudflare__execute")).isError,
			true,
		);
		assert.equal(
			(
				await dispatch(f.ctx, f.agentKey, "list_mcp_resources", {
					server: "idalib",
				})
			).isError,
			true,
		);
		assert.deepEqual(f.clients[0]?.calls, []);
		assert.deepEqual(f.cloudflareCalls, []);
	} finally {
		await f.dispose();
	}
});

for (const source of ["missing", "disabled", "wrong-server"] as const) {
	test(`Configured ${source} source fails before an Agent-local client can activate`, async () => {
		const f = await fixture();
		try {
			if (source === "disabled")
				await f.ctx.loader.update("fixture-idalib", { disabled: true });
			if (source === "wrong-server")
				await f.ctx.loader.update("fixture-idalib", {
					config: { ...connectionConfig, serverName: "wrong-server" },
				});
			await f.ctx.loader.await();
			const before = f.clients.length;
			let modelSteps = 0;
			await assert.rejects(async () => {
				await installAgentPolicy(f.policy.ctx, f.composition, {
					sourceEntry: source === "missing" ? "missing" : "fixture-idalib",
				});
				modelSteps += 1;
			});
			assert.equal(modelSteps, 0);
			assert.equal(f.clients.length, before);
			assert.equal(
				(
					await dispatch(f.ctx, f.agentKey, "list_mcp_resources", {
						server: "cloudflare",
					})
				).isError,
				true,
			);
		} finally {
			await f.dispose();
		}
	});
}
