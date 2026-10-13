import assert from "node:assert/strict";
import test from "node:test";
import { renderToolsSdk } from "@deepseek-ai/dsh-tools";
import { summarizeSdk } from "../src/prompt-metrics.ts";

function sdkText(args: string[], outputs: string[], newline = "\n") {
	return [
		"shared 😀",
		"interface ToolArgsMap {",
		...args,
		"}",
		"",
		"interface ToolOutputMap {",
		...outputs,
		"}",
		"shared footer",
	].join(newline);
}

test("exact member spans include descriptions, nested types, quoted keys and UTF-16 units", () => {
	const args = [
		"  /** First 😀 */\n  ordinary: {\n    nested: {\n      impostor: string;\n    };\n  };\n",
		'  /**\n   * Second description\n   */\n  "mcp__idalib__odd-key": {\n    ordinary: string;\n  };\n',
		"  /** Third description */\n  imagegen: {};\n",
	];
	const outputs = [
		"  ordinary: boolean;\n",
		'  "mcp__idalib__odd-key": {\n    nested: string;\n  };\n',
		"  imagegen: string;\n",
	];
	const sdk = sdkText(
		[args.join("").slice(0, -1)],
		[outputs.join("").slice(0, -1)],
	);
	const metrics = summarizeSdk(sdk);
	assert.equal(metrics.totalChars, sdk.length);
	assert.equal(metrics.toolCount, 3);
	const names = ["ordinary", "mcp__idalib__odd-key", "imagegen"];
	for (const [index, name] of names.entries()) {
		const tool = metrics.tools.find((entry) => entry.name === name);
		assert.ok(tool);
		assert.equal(tool.argsChars, args[index]?.length);
		assert.equal(tool.outputChars, outputs[index]?.length);
		assert.equal(tool.totalChars, tool.argsChars + tool.outputChars);
	}
	const declarations = [...args, ...outputs].reduce(
		(sum, member) => sum + member.length,
		0,
	);
	assert.equal(metrics.declarationChars, declarations);
	assert.equal(metrics.sharedChars, sdk.length - declarations);
	assert.equal(
		metrics.groups.reduce((sum, group) => sum + group.chars, 0),
		declarations,
	);
	assert.deepEqual(
		metrics.groups.map((group) => group.name),
		["IDA/MCP", "other", "subscription media/search"],
	);
	assert.deepEqual(
		metrics.tools.map((tool) => tool.totalChars),
		metrics.tools.map((tool) => tool.totalChars).sort((a, b) => b - a),
	);
	assert.equal(JSON.stringify(metrics).includes("Second description"), false);
});

test("all designated helpers are grouped without treating nested properties as tools", () => {
	const groups = new Map([
		[
			"IDA/MCP",
			[
				"mcp__idalib__decompile",
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
			],
		],
		[
			"subscription media/search",
			["imagegen", "image_generate", "video_generate", "x_search"],
		],
		[
			"delegation",
			[
				"subagent",
				"subagent_fork",
				"list_agents",
				"send_message",
				"interrupt_agent",
			],
		],
		["other", ["read", "mcp__cloudflare__docs"]],
	]);
	const names = [...groups.values()].flat();
	const members = names.map(
		(name) => `  ${name}: {\n    nested: string;\n  };`,
	);
	const metrics = summarizeSdk(sdkText(members, members));
	assert.equal(metrics.toolCount, names.length);
	for (const [name, tools] of groups) {
		const group = metrics.groups.find((entry) => entry.name === name);
		assert.ok(group);
		assert.equal(group.toolCount, tools.length);
		assert.equal(
			group.chars,
			metrics.tools
				.filter((tool) => tools.includes(tool.name))
				.reduce((sum, tool) => sum + tool.totalChars, 0),
		);
	}
});

test("the actual exported SDK renderer retains every member and description character", () => {
	const schemas: Parameters<typeof renderToolsSdk>[0] = [
		{
			name: "read",
			description: "Read 😀 exact text",
			parameters: {
				type: "object",
				properties: {
					nested: {
						type: "object",
						properties: {
							subagent: { type: "string", description: "Not a tool" },
						},
						required: ["subagent"],
					},
				},
				required: ["nested"],
			},
			output: {
				type: "object",
				properties: { content: { type: "string" } },
				required: ["content"],
			},
		},
		{
			name: "mcp__idalib__decompile",
			description: "Analyze\nwithout losing docs",
			parameters: {
				type: "object",
				properties: { addr: { type: "string" } },
				required: ["addr"],
			},
			output: { type: "string" },
		},
		{
			name: "odd-key",
			description: "Quoted tool",
			parameters: { type: "object", properties: {} },
			output: { type: "boolean" },
		},
	];
	const sdk = renderToolsSdk(schemas);
	const metrics = summarizeSdk(sdk);
	assert.equal(metrics.toolCount, schemas.length);
	assert.equal(metrics.totalChars, sdk.length);
	const argsBody = sdk.split("interface ToolArgsMap {\n")[1]?.split("\n}")[0];
	const outputBody = sdk
		.split("interface ToolOutputMap {\n")[1]
		?.split("\n}")[0];
	assert.ok(argsBody);
	assert.ok(outputBody);
	assert.equal(
		metrics.declarationChars,
		argsBody.length + outputBody.length + 2,
	);
	assert.equal(
		metrics.tools.reduce((sum, tool) => sum + tool.totalChars, 0),
		metrics.declarationChars,
	);
	assert.equal(
		metrics.groups.reduce((sum, group) => sum + group.chars, 0),
		metrics.declarationChars,
	);
	assert.equal(metrics.declarationChars + metrics.sharedChars, sdk.length);
	for (const schema of schemas) {
		const standalone = summarizeSdk(renderToolsSdk([schema])).tools[0];
		assert.deepEqual(
			metrics.tools.find((tool) => tool.name === schema.name),
			standalone,
		);
	}
});

test("CRLF line endings are counted verbatim", () => {
	const member = "  /** Description 😀 */\r\n  read: string;";
	const sdk = sdkText([member], ["  read: boolean;"], "\r\n");
	const metrics = summarizeSdk(sdk);
	assert.equal(metrics.tools[0]?.argsChars, member.length + 2);
	assert.equal(metrics.tools[0]?.outputChars, "  read: boolean;\r\n".length);
	assert.equal(metrics.totalChars, sdk.length);
});

test("empty maps and an absent SDK preserve total/shared accounting", () => {
	for (const sdk of ["", renderToolsSdk([]), sdkText([], [])]) {
		assert.deepEqual(summarizeSdk(sdk), {
			totalChars: sdk.length,
			declarationChars: 0,
			sharedChars: sdk.length,
			toolCount: 0,
			groups: [],
			tools: [],
		});
	}
});

test("missing markers or mismatched maps fail transparently", () => {
	assert.throws(
		() => summarizeSdk("some unknown SDK"),
		/Missing SDK map: ToolArgsMap/,
	);
	assert.throws(
		() => summarizeSdk("interface ToolArgsMap {}"),
		/Missing SDK map: ToolOutputMap/,
	);
	assert.throws(
		() => summarizeSdk(sdkText(["  read: {};"], [])),
		/do not match/,
	);
	assert.throws(
		() => summarizeSdk("interface ToolArgsMap {\n  read: {};"),
		/Unterminated SDK map/,
	);
});
