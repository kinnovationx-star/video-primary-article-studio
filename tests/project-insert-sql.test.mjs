import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/[[...path]]/route.ts", import.meta.url),
  "utf8",
);

test("production project INSERT has one value for every column", () => {
  const match = routeSource.match(
    /INSERT INTO production_projects \(([^)]+)\) VALUES \(([^)]+)\)/,
  );

  assert.ok(match, "production_projects INSERT was not found");

  const columns = match[1].split(",").map((value) => value.trim());
  const placeholders = match[2].match(/\?/g) ?? [];

  assert.equal(columns.length, 16);
  assert.equal(placeholders.length, columns.length);
});
