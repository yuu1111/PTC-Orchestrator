export interface SdkToolMetrics {
	name: string;
	argsChars: number;
	outputChars: number;
	totalChars: number;
}

export interface SdkGroupMetrics {
	name: string;
	toolCount: number;
	chars: number;
}

export interface SdkMetrics {
	totalChars: number;
	declarationChars: number;
	sharedChars: number;
	toolCount: number;
	groups: SdkGroupMetrics[];
	tools: SdkToolMetrics[];
}

function mapBody(sdk: string, mapName: string): string {
	const marker = new RegExp(`^interface ${mapName} [{]`, "m").exec(sdk);
	if (!marker) throw new Error(`Missing SDK map: ${mapName}`);
	const tail = sdk.slice(marker.index + marker[0].length);
	const end = tail.startsWith("}") ? 0 : /^}/m.exec(tail)?.index;
	if (end === undefined) throw new Error(`Unterminated SDK map: ${mapName}`);
	return tail.slice(0, end);
}

function memberName(key: string): string {
	if (key.startsWith('"')) {
		const name: unknown = JSON.parse(key);
		if (typeof name !== "string") throw new Error("Invalid SDK member key");
		return name;
	}
	if (key.startsWith("'")) return key.slice(1, -1);
	return key;
}

function memberStarts(body: string) {
	const starts: { name: string; start: number }[] = [];
	let descriptionStart: number | undefined;
	let inComment = false;
	for (const line of body.matchAll(/[^\n]*\n|[^\n]+$/g)) {
		const text = line[0];
		if (inComment) {
			inComment = !text.includes("*/");
			continue;
		}
		if (text.startsWith("  /**")) {
			descriptionStart ??= line.index;
			inComment = !text.includes("*/");
			continue;
		}
		const key =
			/^ {2}([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'):/.exec(
				text,
			)?.[1];
		if (!key) continue;
		starts.push({
			name: memberName(key),
			start: descriptionStart ?? line.index,
		});
		descriptionStart = undefined;
	}
	if (inComment || descriptionStart !== undefined)
		throw new Error("Unattached SDK description");
	return starts;
}

function mapMembers(sdk: string, mapName: string): Map<string, number> {
	const body = mapBody(sdk, mapName);
	const starts = memberStarts(body);
	const members = new Map<string, number>();
	for (const [index, member] of starts.entries()) {
		if (members.has(member.name))
			throw new Error(`Duplicate SDK member: ${member.name}`);
		members.set(
			member.name,
			(starts[index + 1]?.start ?? body.length) - member.start,
		);
	}
	if (members.size === 0 && body.trim())
		throw new Error(`Unrecognized SDK members in ${mapName}`);
	return members;
}

function groupName(name: string): string {
	if (
		name.startsWith("mcp__idalib__") ||
		[
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		].includes(name)
	)
		return "IDA/MCP";
	if (
		["imagegen", "image_generate", "video_generate", "x_search"].includes(name)
	)
		return "subscription media/search";
	if (
		name.startsWith("subagent") ||
		["list_agents", "send_message", "interrupt_agent"].includes(name)
	)
		return "delegation";
	return "other";
}

export function summarizeSdk(sdk: string): SdkMetrics {
	const args = sdk.length
		? mapMembers(sdk, "ToolArgsMap")
		: new Map<string, number>();
	const outputs = sdk.length
		? mapMembers(sdk, "ToolOutputMap")
		: new Map<string, number>();
	if (
		args.size !== outputs.size ||
		[...args.keys()].some((name) => !outputs.has(name))
	)
		throw new Error("SDK argument/output members do not match");
	const tools = [...args]
		.map(([name, argsChars]) => {
			const outputChars = outputs.get(name) ?? 0;
			return {
				name,
				argsChars,
				outputChars,
				totalChars: argsChars + outputChars,
			};
		})
		.sort(
			(a, b) => b.totalChars - a.totalChars || a.name.localeCompare(b.name),
		);
	const groupsByName = new Map<string, SdkGroupMetrics>();
	for (const tool of tools) {
		const name = groupName(tool.name);
		const group = groupsByName.get(name) ?? { name, toolCount: 0, chars: 0 };
		group.toolCount++;
		group.chars += tool.totalChars;
		groupsByName.set(name, group);
	}
	const declarationChars = tools.reduce(
		(sum, tool) => sum + tool.totalChars,
		0,
	);
	return {
		totalChars: sdk.length,
		declarationChars,
		sharedChars: sdk.length - declarationChars,
		toolCount: tools.length,
		groups: [...groupsByName.values()].sort(
			(a, b) => b.chars - a.chars || a.name.localeCompare(b.name),
		),
		tools,
	};
}
