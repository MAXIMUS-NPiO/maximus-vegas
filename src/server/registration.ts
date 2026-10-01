/**
 * Additional registration fields defined by the organiser, and the answers entrants give. Pure — no I/O.
 *
 *  - Up to five fields: free text, a choice from a list, or a checkbox (for example "I accept the event rules").
 *  - Fields are frozen once anyone has registered, so every answer always matches the question it was given for.
 *  - Answers are visible only to the tournament's staff; they are part of the entrant's data export and are
 *    erased when the account that gave them is deleted.
 */
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export const MAX_FIELDS = 5;
export const FIELD_TYPES = ["text", "choice", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type RegField = { key: string; label: string; type: FieldType; options: string[]; required: boolean };
export type Answers = Record<string, string | boolean>;

const text = (value: unknown) => String(value ?? "").trim();

/**
 * Reads the organiser's field rows (field1Label, field1Type, field1Options, field1Required … field5*).
 * Rows without a label are skipped; keys are f1, f2 … in the order the fields are shown.
 */
export function parseRegistrationFields(input: Record<string, unknown>): RegField[] {
  const out: RegField[] = [];
  for (let i = 1; i <= MAX_FIELDS; i++) {
    const label = text(input[`field${i}Label`]);
    if (!label) continue;
    if (label.length < 2 || label.length > 80 || /[\r\n]/.test(label)) fail("invalid_registration_fields");
    const type = text(input[`field${i}Type`]) || "text";
    if (!(FIELD_TYPES as readonly string[]).includes(type)) fail("invalid_registration_fields");
    let options: string[] = [];
    if (type === "choice") {
      options = [...new Set(text(input[`field${i}Options`]).split(/[,\n;]+/).map((o) => o.trim()).filter(Boolean))];
      if (options.length < 2 || options.length > 20 || options.some((o) => o.length > 60)) fail("invalid_registration_fields");
    }
    out.push({ key: `f${out.length + 1}`, label, type: type as FieldType, options, required: v.bool(input[`field${i}Required`]) });
  }
  return out;
}

/** Stored fields, defensive against partial JSON. */
export function fieldsOf(t: { registration_fields?: unknown }): RegField[] {
  const raw = Array.isArray(t.registration_fields) ? (t.registration_fields as Partial<RegField>[]) : [];
  return raw
    .filter((f) => typeof f?.key === "string" && typeof f?.label === "string" && (FIELD_TYPES as readonly string[]).includes(String(f?.type)))
    .map((f) => ({ key: f.key!, label: f.label!, type: f.type as FieldType, options: Array.isArray(f.options) ? f.options.map(String) : [], required: Boolean(f.required) }));
}

/** Validates an entrant's answers (inputs answer_f1 … answer_f5) against the fields. */
export function parseAnswers(fields: RegField[], input: Record<string, unknown>): Answers | null {
  if (!fields.length) return null;
  const out: Answers = {};
  for (const f of fields) {
    const raw = input[`answer_${f.key}`];
    if (f.type === "checkbox") {
      const checked = v.bool(raw);
      if (f.required && !checked) fail("invalid_answers");
      out[f.key] = checked;
      continue;
    }
    const value = text(raw);
    if (!value) {
      if (f.required) fail("invalid_answers");
      continue;
    }
    if (f.type === "choice") {
      if (!f.options.includes(value)) fail("invalid_answers");
      out[f.key] = value;
    } else {
      if (value.length > 300 || /[\r\n]/.test(value)) fail("invalid_answers");
      out[f.key] = value;
    }
  }
  return out;
}

/** Answers paired with their questions, for staff views. */
export function answerLines(fields: RegField[], answers: unknown, yes: string, no: string): Array<[string, string]> {
  const a = (answers ?? {}) as Answers;
  return fields.map((f) => {
    const value = a[f.key];
    return [f.label, f.type === "checkbox" ? (value ? yes : no) : value === undefined || value === "" ? "—" : String(value)];
  });
}
