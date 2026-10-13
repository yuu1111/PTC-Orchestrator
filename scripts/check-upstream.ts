import assert from "node:assert/strict";
import { readComposition } from "./composition.ts";

const source = process.argv[2];
if (!source) {
	console.error(
		"Usage: npm run check:upstream -- <absolute path to shipped ptc.patch.yml>",
	);
	process.exitCode = 1;
} else {
	const baseline = await readComposition(source);
	const local = await readComposition(
		new URL("../cordis.patch.yml", import.meta.url),
	);
	assert.equal(baseline[0].insert[0].config.id, "ptc");
	assert.equal(local[0].insert[0].config.id, "local-orchestrator");
	assert.deepEqual(
		local[0].insert[0].config.plugins,
		baseline[0].insert[0].config.plugins,
	);
	console.log("PASS: local plugin composition matches shipped PTC");
}
