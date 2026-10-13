import assert from "node:assert/strict";
import { presetRow, readComposition } from "./composition.ts";

const source = process.argv[2];
if (!source) {
	console.error(
		"Usage: npm run check:upstream -- <absolute path to shipped ptc.patch.yml>",
	);
	process.exitCode = 1;
} else {
	const baseline = presetRow(await readComposition(source));
	const local = presetRow(
		await readComposition(new URL("../cordis.patch.yml", import.meta.url)),
	);
	assert.equal(baseline.config.id, "ptc");
	assert.equal(local.config.id, "ptc-orchestrator");
	assert.deepEqual(
		local.config.plugins.filter((plugin) => plugin.id !== "ida-only"),
		baseline.config.plugins,
	);
	console.log(
		"PASS: PTC baseline matches upstream apart from the explicit IDA-only policy",
	);
}
