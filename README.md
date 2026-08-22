# yaml-caret

A YAML parser and pretty printer for TypeScript, with error messages that
tell you exactly where the problem is.

## Why

Most YAML parsing errors look like this:

```
YAMLException: bad indentation of a mapping entry
```

No line number, no column, no idea which of your 400 lines of config is
wrong. You end up bisecting the file by deleting half of it until the error
disappears. That's a bad way to spend twenty minutes.

YAML also has a few footguns that are easy to hit by accident: mixing tabs
and spaces in indentation, a duplicate key that silently overwrites an
earlier one, an unterminated quote that swallows the rest of the document.
A parser that just says "parse error" on these isn't pulling its weight.

This library reports every error with a line, a column, and a caret
pointing at the source, in the style of a compiler diagnostic. Duplicate
keys additionally point back at where the key was first defined.

## Install

There's nothing to install — no dependencies, just TypeScript compiled with
`tsc`. Copy the `src/` files into your project, or build this package and
import from `dist/`.

## Usage

```ts
import { parseYaml, stringifyYaml, YamlParseError } from './src/index';

const config = parseYaml(`
name: my-service
port: 8080
retries: 3
tags:
  - web
  - internal
database:
  host: localhost
  port: 5432
`);

console.log(config.database.port); // 5432
console.log(stringifyYaml(config)); // canonical YAML, re-serialized
```

When the input is malformed, `parseYaml` throws a `YamlParseError` whose
`.message` is already formatted for a terminal:

```ts
try {
  parseYaml('name: web\nname: api\n');
} catch (err) {
  if (err instanceof YamlParseError) {
    console.error(err.message);
  }
}
```

```
duplicate key "name" (line 2, column 1)
  |
2 | name: api
  | ^
note: first defined here (line 1, column 1)
  |
1 | name: web
  | ^
```

A tab used for indentation gets the same treatment:

```
tab characters are not allowed for indentation (line 3, column 3)
  |
3 |   ->  host: localhost
  |   ^
```

(shown with `->` standing in for the actual tab character)

The `line`, `column`, and `sourceLine` fields on `YamlParseError` are also
available directly, if you want to build your own error UI instead of using
the pre-formatted message.

## Command line

```sh
node dist/index.js parse config.yaml    # prints the parsed value as JSON
node dist/index.js format config.yaml   # re-prints as canonical YAML
```

## What's supported

- Block mappings and sequences, including `- key: value` inline sequence
  items and arbitrarily nested indentation
- Flow collections, `[a, b]` and `{k: v}`, including nesting (`[{a: 1}]`),
  anywhere a value is expected — but each one must fit on a single line
- Plain, single-quoted, and double-quoted scalars, with standard escapes
  in double-quoted strings
- `null`, `true`/`false`, integers, and floats, recognized by value
- Comments (`#`, respecting quotes)
- A single leading `---` document marker and a single trailing `...`
- Block scalars, literal (`|`) and folded (`>`), with chomping indicators
  (`-` strip, `+` keep) and an explicit indentation indicator (e.g. `|2`)

## What's not supported yet

- Multi-line flow collections
- Anchors and aliases (`&name`, `*name`)
- Multiple documents in one stream
- Schema validation beyond "this is structurally valid YAML" — the parser
  checks syntax, not your application's shape

See the code comments in `src/parser.ts` for where these are cut off.

## License

MIT, see LICENSE.
