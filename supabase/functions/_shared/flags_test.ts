// Run with: deno test supabase/functions/_shared/
// Self-contained on purpose — this repo has no test dependencies and no CI, so a
// test that needs a network fetch to run is a test that will not get run.

import { isFlagEnabled } from "./flags.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

// Regression: LINKEDIN_ORG_MODE used a strict, case-sensitive comparison, so
// "True" or a trailing CR meant the operator believed company posting was on
// while every post went out on an employee's personal profile.
Deno.test("isFlagEnabled accepts the shapes an operator actually types", () => {
  for (const v of ["true", "True", "TRUE", "  true  ", "true\r", "\ttrue\n"]) {
    assertEquals(isFlagEnabled(v), true, `${JSON.stringify(v)} should enable`);
  }
});

Deno.test("isFlagEnabled treats every other value as off", () => {
  for (const v of ["false", "False", "FALSE", "0", "no", "off", "", "   "]) {
    assertEquals(isFlagEnabled(v), false, `${JSON.stringify(v)} should not enable`);
  }
});

Deno.test("isFlagEnabled does not accept other truthy conventions", () => {
  // Accepting these would make the flag mean different things to different people.
  for (const v of ["1", "yes", "on", "y"]) {
    assertEquals(isFlagEnabled(v), false, `${JSON.stringify(v)} should not enable`);
  }
});

Deno.test("isFlagEnabled handles an unset secret", () => {
  assertEquals(isFlagEnabled(undefined), false, "undefined should not enable");
  assertEquals(isFlagEnabled(null), false, "null should not enable");
});
