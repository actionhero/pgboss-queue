import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.equal(
  process.versions.bun,
  undefined,
  "this script must run on Node, not Bun",
);
assert.ok(process.versions.node, "expected a Node.js runtime");

assert.equal(typeof pkg.name, "string");
assert.equal(typeof pkg.exports?.["."]?.import, "string");

const entry = pkg.exports["."].import;
const url = pathToFileURL(join(root, entry)).href;
const mod = await import(url);

assert.equal(typeof mod, "object");
assert.ok(mod);

process.stdout.write(
  `imported ${pkg.name} from ${entry} on node ${process.versions.node}\n`,
);
