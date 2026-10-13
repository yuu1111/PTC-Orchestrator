import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import {
	flattenPlugins,
	pluginConfig,
	readComposition,
} from "../scripts/composition.ts";

const patches = await readComposition(
	new URL("../cordis.patch.yml", import.meta.url),
);
const row = patches[0].insert[0];
const plugins = row.config.plugins;

const entries = flattenPlugins(plugins);

function plugin(id: string) {
	const entry = entries.find((entry) => entry.id === id);
	assert.ok(entry, `missing plugin: ${id}`);
	return entry;
}

test("bundle exposes the preset patch without a Host code entry point", async () => {
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
	assert.equal(manifest.main, undefined);
});

test("new preset is inserted without overriding shipped presets", () => {
	assert.equal(patches.length, 1);
	assert.deepEqual(Object.keys(patches[0]), ["insert"]);
	assert.equal(patches[0].insert.length, 1);
	assert.equal(row.id, "preset-local-orchestrator");
	assert.equal(row.name, "@deepseek-ai/dsh-agent-preset");
	assert.equal(row.config.id, "local-orchestrator");
	assert.equal(row.config.name, "Local Orchestrator (PTC Base)");
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

test("PTC presentation remains enabled", () => {
	const presentation = plugin("tool-presentation");
	assert.equal(pluginConfig(presentation).mode, "ptc");
	assert.notEqual(presentation.disabled, true);
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
	assert.equal(pluginConfig(spawn).modelSelectionSettings, true);
	assert.equal(pluginConfig(fork).provider, "fork");
	assert.equal(pluginConfig(spawn).agentOptions, undefined);
	assert.equal(pluginConfig(fork).agentOptions, undefined);
});
