import test from "node:test";
import assert from "node:assert/strict";
import { validateInquiry } from "../src/lib/inquiries.ts";
const valid = {
  name: " Partner ",
  email: "Team@Example.com",
  company: "Example",
  interest: "partnership",
  message: "Demo request",
  lang: "ru",
  consent: true,
};
test("normalizes a valid inquiry without keeping unknown fields", () => {
  const result = validateInquiry({ ...valid, admin: true });
  assert.equal(result?.name, "Partner");
  assert.equal(result?.email, "team@example.com");
  assert.ok(!("admin" in result!));
});
test("rejects missing consent, invalid email, unknown interest and locale", () => {
  for (const patch of [
    { consent: false },
    { consent: "true" },
    { email: "bad" },
    { interest: "other" },
    { lang: "fr" },
    { name: "\r\nInjected" },
    { company: 5 },
  ])
    assert.equal(validateInquiry({ ...valid, ...patch }), null);
});
test("limits message and name size and rejects malformed values", () => {
  assert.equal(validateInquiry({ ...valid, message: "x".repeat(3001) }), null);
  assert.equal(validateInquiry({ ...valid, name: "x".repeat(101) }), null);
  for (const value of [null, [], 42, "text", {}])
    assert.equal(validateInquiry(value), null);
});
