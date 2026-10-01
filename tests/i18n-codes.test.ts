import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES } from "../src/server/errors.ts";
import { dict } from "../src/lib/i18n.ts";

test("every error code has a message in Russian and English", () => {
  for (const lang of ["ru", "en"] as const) {
    const errors = (dict(lang) as unknown as { errors: Record<string, string> }).errors;
    const missing = ERROR_CODES.filter((code) => !errors[code]?.trim());
    assert.deepEqual(missing, [], `${lang}: error codes without a message`);
  }
});
