import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";

const expression = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	construct: (source: unknown) => ({ expression: z.string().parse(source) }),
});
const yamlSchema = yaml.DEFAULT_SCHEMA.extend([expression]);
const pluginSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		group: z.boolean().optional(),
		config: z.unknown().optional(),
		disabled: z.unknown().optional(),
	})
	.passthrough();
const pluginsSchema = z.array(pluginSchema);
const presetSchema = z
	.object({
		id: z.string(),
		name: z.literal("@deepseek-ai/dsh-agent-preset"),
		config: z
			.object({
				id: z.string(),
				name: z.string().optional(),
				description: z.string().optional(),
				order: z.number().optional(),
				plugins: pluginsSchema,
			})
			.passthrough(),
	})
	.passthrough();
const compositionSchema = z.tuple([z.object({ insert: pluginsSchema })]);

export async function readComposition(path: string | URL) {
	return compositionSchema.parse(
		yaml.load(await readFile(path, "utf8"), { schema: yamlSchema }),
	);
}

export function presetRow(composition: z.infer<typeof compositionSchema>) {
	return presetSchema.parse(
		composition[0].insert.find(
			(entry) => entry.name === "@deepseek-ai/dsh-agent-preset",
		),
	);
}

export function flattenPlugins(
	rows: z.infer<typeof pluginsSchema>,
): z.infer<typeof pluginsSchema> {
	return rows.flatMap((entry) => [
		entry,
		...(entry.group ? flattenPlugins(pluginsSchema.parse(entry.config)) : []),
	]);
}

export function pluginConfig(entry: z.infer<typeof pluginSchema>) {
	return z.record(z.string(), z.unknown()).parse(entry.config);
}
