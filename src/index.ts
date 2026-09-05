export { parseYaml, parseYamlDocuments, YamlParseError } from './parser';
export type { YamlValue, YamlScalar, YamlErrorNote } from './parser';
export { stringifyYaml } from './printer';
export { validateSchema, SchemaValidationError } from './schema';
export type { Schema } from './schema';

import { readFileSync } from 'node:fs';
import { parseYaml, YamlParseError } from './parser';
import { stringifyYaml } from './printer';

function main(argv: string[]): void {
  const [, , command, file] = argv;
  if (!command || !file) {
    process.stderr.write('usage: yaml-caret <parse|format> <file.yaml>\n');
    process.exitCode = 1;
    return;
  }

  const source = readFileSync(file, 'utf8');
  try {
    const value = parseYaml(source);
    if (command === 'parse') {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    } else if (command === 'format') {
      process.stdout.write(stringifyYaml(value));
    } else {
      process.stderr.write(`unknown command "${command}"\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof YamlParseError) {
      process.stderr.write(`${file}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv);
}
