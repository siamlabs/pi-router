/**
 * Runs every test in _harness.ts in its own subprocess (fresh module state).
 * Usage: bun _run.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const src = readFileSync(join(HERE, "_harness.ts"), "utf-8");
const count = (src.match(/^test\(/gm) || []).length;

let totalFail = 0;
console.log("=== router extension tests ===\n");

for (let i = 0; i < count; i++) {
  const res = spawnSync("bun", ["_harness.ts", String(i)], {
    cwd: HERE,
    encoding: "utf-8",
  });
  const out = (res.stdout || "") + (res.stderr || "");
  process.stdout.write(out);
  const result = out.match(/__RESULT__ (\S+)/)?.[1] ?? "UNKNOWN";
  const status = result === "PASS" ? "PASS" : result.startsWith("FAIL") ? "FAIL" : "??";
  if (status !== "PASS") totalFail++;
}

console.log(totalFail === 0 ? "ALL TESTS PASSED" : `${totalFail} TEST(S) FAILED`);
process.exit(totalFail === 0 ? 0 : 1);
