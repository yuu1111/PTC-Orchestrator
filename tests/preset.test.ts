import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import {
	flattenPlugins,
	pluginConfig,
	presetRow,
	readComposition,
} from "../scripts/composition.ts";

const patches = await readComposition(
	new URL("../cordis.patch.yml", import.meta.url),
);
const row = presetRow(patches);
const plugins = row.config.plugins;

const entries = flattenPlugins(plugins);

function plugin(id: string) {
	const entry = entries.find((entry) => entry.id === id);
	assert.ok(entry, `missing plugin: ${id}`);
	return entry;
}

test("bundle exposes the preset patch and compiled TypeScript policy", async () => {
	const manifestSchema = z.object({
		dsh: z.object({ bundle: z.object({ patch: z.string() }) }),
		main: z.unknown().optional(),
	});
	const manifest = manifestSchema.parse(
		JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		),
	);
	assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
	assert.equal(manifest.main, "dist/main.js");
});

test("new preset is inserted without overriding shipped presets", () => {
	assert.equal(patches.length, 1);
	assert.deepEqual(Object.keys(patches[0]), ["insert"]);
	assert.equal(patches[0].insert.length, 2);
	assert.equal(patches[0].insert[0]?.id, "ptc-orchestrator-policy-runtime");
	assert.equal(patches[0].insert[0]?.name, "./dist/register.js");
	assert.equal(row.id, "preset-ptc-orchestrator");
	assert.equal(row.name, "@deepseek-ai/dsh-agent-preset");
	assert.equal(row.config.id, "ptc-orchestrator");
	assert.equal(row.config.name, "PTC-Orchestrator");
});

test("every plugin has a unique row identity", () => {
	assert.ok(entries.length > 0);
	assert.ok(
		entries.every(
			(entry) => typeof entry.id === "string" && typeof entry.name === "string",
		),
	);
	assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
});

test("PTC execution remains enabled without the deprecated presentation shim", () => {
	const executor = plugin("tool-executor-ptc");
	assert.equal(executor.name, "@deepseek-ai/dsh-tool-executor-ptc");
	assert.notEqual(executor.disabled, true);
	assert.equal(
		entries.some(
			(entry) => entry.name === "@deepseek-ai/dsh-agent-tool-presentation",
		),
		false,
	);
});

test("plan mode requires user approval rather than tool completion", () => {
	const section = z.string().parse(pluginConfig(plugin("plan-mode")).section);
	assert.match(
		section,
		/Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode\./,
	);
	assert.doesNotMatch(section, /until exit_plan_mode succeeds/);
});

test("platform-specific shell expressions remain unevaluated", () => {
	assert.deepEqual(plugin("tool-bash").disabled, {
		expression: "process.platform === 'win32'",
	});
	assert.deepEqual(plugin("tool-pwsh").disabled, {
		expression: "process.platform !== 'win32'",
	});
});

test("delegation retains spawn and fork without choosing a model", () => {
	const spawn = plugin("tool-subagent");
	const fork = plugin("tool-subagent-fork");
	assert.equal(pluginConfig(spawn).provider, "spawn");
	assert.equal(pluginConfig(spawn).modelSelection, true);
	assert.equal(pluginConfig(spawn).modelDiscovery, true);
	assert.equal(pluginConfig(spawn).modelSelectionSettings, undefined);
	assert.equal(pluginConfig(spawn).backgroundMode, undefined);
	assert.equal(pluginConfig(fork).backgroundMode, undefined);
	assert.equal(pluginConfig(fork).provider, "fork");
	assert.equal(pluginConfig(spawn).agentOptions, undefined);
	assert.equal(pluginConfig(fork).agentOptions, undefined);
});
