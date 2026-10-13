import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readComposition } from '../scripts/composition.mjs';

const patches = await readComposition(new URL('../cordis.patch.yml', import.meta.url));
const row = patches[0].insert[0];
const plugins = row.config.plugins;
function flatten(rows) {
  return rows.flatMap((entry) => [entry, ...(entry.group ? flatten(entry.config) : [])]);
}
const entries = flatten(plugins);

test('bundle exposes the preset patch without a Host code entry point', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.main, undefined);
});

test('new preset is inserted without overriding shipped presets', () => {
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0]), ['insert']);
  assert.equal(patches[0].insert.length, 1);
  assert.equal(row.id, 'preset-local-orchestrator');
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'local-orchestrator');
  assert.equal(row.config.name, 'Local Orchestrator (PTC Base)');
});

test('every plugin has a unique row identity', () => {
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => typeof entry.id === 'string' && typeof entry.name === 'string'));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
});

test('PTC presentation remains enabled', () => {
  const presentation = entries.find((entry) => entry.id === 'tool-presentation');
  assert.equal(presentation.config.mode, 'ptc');
  assert.notEqual(presentation.disabled, true);
});

test('platform-specific shell expressions remain unevaluated', () => {
  assert.deepEqual(entries.find((entry) => entry.id === 'tool-bash').disabled, { expression: "process.platform === 'win32'" });
  assert.deepEqual(entries.find((entry) => entry.id === 'tool-pwsh').disabled, { expression: "process.platform !== 'win32'" });
});

test('delegation retains spawn and fork without choosing a model', () => {
  const spawn = entries.find((entry) => entry.id === 'tool-subagent');
  const fork = entries.find((entry) => entry.id === 'tool-subagent-fork');
  assert.equal(spawn.config.provider, 'spawn');
  assert.equal(spawn.config.modelSelectionSettings, true);
  assert.equal(fork.config.provider, 'fork');
  assert.equal(spawn.config.agentOptions, undefined);
  assert.equal(fork.config.agentOptions, undefined);
});
