import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

const expression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (source) => ({ expression: source }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([expression]);

export async function readComposition(path) {
  return yaml.load(await readFile(path, 'utf8'), { schema });
}
