import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Execute the real TSX components, including ActionForm and Field, without a dev server or database.
const require = createRequire(import.meta.url);
const nextLink = pathToFileURL(require.resolve("next/link")).href;
const sourceRoot = new URL("../src/", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) specifier = new URL(specifier.slice(2), sourceRoot).href;
    if (specifier === "next/link") specifier = nextLink;
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      for (const extension of [".tsx", ".ts"]) {
        const candidate = `${fileURLToPath(url)}${extension}`;
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        fileName: fileURLToPath(url),
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());

const { ScoreCorrectionForm } = await import("../src/components/score-correction.tsx");
const entry = {
  id: "10000000-0000-4000-8000-000000000001",
  registration_id: "10000000-0000-4000-8000-000000000002",
  revision: 7,
  review: "rejected",
  match_ref: "verified-match-42",
  evidence_url: "https://evidence.example.test/proof?match=42&view=full",
  kills: 12, assists: 6, deaths: 3, headshots: 8, damage: 1234, distance: 5678,
  placement: 2 as const,
};
const tournament = {
  id: "10000000-0000-4000-8000-000000000003",
  status: "IN_PROGRESS" as const,
  submission_deadline: "2000-01-01T00:00:00Z",
};

function render(lang: "ru" | "en", changes: Partial<typeof entry> = {}, status = tournament.status as string) {
  return renderToStaticMarkup(createElement(ScoreCorrectionForm, {
    lang, back: `/${lang}/organizer/t/local-correction`, tournament: { ...tournament, status }, entry: { ...entry, ...changes },
  }));
}

function attributes(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function input(html: string, name: string) {
  const tag = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => attributes(tag).name === name);
  assert.ok(tag, `Rendered form must contain input ${name}`);
  return attributes(tag);
}

for (const lang of ["ru", "en"] as const) {
  test(`${lang}: rendered rejected-entry form remains available after the participant deadline with fixed identity`, () => {
    assert.ok(new Date(tournament.submission_deadline).getTime() < Date.now());
    const html = render(lang);
    const form = html.match(/<form\b[^>]*>/)?.[0];
    assert.ok(form, "Organizer correction must render after the participant submission deadline");
    assert.equal(attributes(form).method, "post");
    assert.equal(attributes(form).action, `/api/a/score.log?lang=${lang}`);
    for (const [name, value] of Object.entries({
      lang, back: `/${lang}/organizer/t/local-correction`, tournament: tournament.id,
      registration: entry.registration_id, correction: `${entry.id}:${entry.revision}`,
    })) {
      assert.deepEqual(input(html, name), { type: "hidden", name, value });
    }
    assert.doesNotMatch(html, /<select\b[^>]*name="registration"/);
    assert.ok(html.includes(lang === "ru" ? "Исправить результат" : "Correct result"));
  });

  test(`${lang}: correction preserves every editable score value and requires an explanation`, () => {
    const html = render(lang);
    for (const name of ["kills", "assists", "deaths", "headshots", "damage", "distance"] as const) {
      const field = input(html, name);
      assert.equal(field.type, "number");
      assert.equal(field.value, String(entry[name]));
      assert.equal(field.required, "");
    }
    assert.match(html, /<select\b[^>]*name="placement"[^>]*>[\s\S]*?<option\b[^>]*value="2"[^>]*selected=""/);
    assert.equal(input(html, "evidence").type, "url");
    assert.equal(input(html, "evidence").value, entry.evidence_url.replaceAll("&", "&amp;"));
    const reason = input(html, "correctionReason");
    assert.equal(reason.required, "");
    assert.equal(reason.minLength, "5");
    assert.equal(reason.maxLength, "500");
    assert.ok(html.includes(lang === "ru" ? "Причина исправления" : "Correction reason"));
    const match = input(html, "matchRef");
    assert.equal(match.value, entry.match_ref);
    assert.equal(match.readOnly, "");
    assert.equal(match.disabled, undefined, "Readonly match identity must still be included in the POST");
  });

  test(`${lang}: a legacy blank match reference is editable and legacy HTTP evidence is preserved`, () => {
    const html = render(lang, { match_ref: "   ", evidence_url: "http://legacy.example.test/proof" });
    const match = input(html, "matchRef");
    assert.equal(match.value, "");
    assert.equal(match.required, "");
    assert.equal(match.readOnly, undefined);
    assert.equal(input(html, "evidence").value, "http://legacy.example.test/proof");
    assert.equal(input(html, "evidence").pattern, undefined, "Unchanged legacy evidence remains submittable");
  });

  test(`${lang}: only rejected results in a running tournament expose correction controls`, () => {
    for (const review of ["pending", "accepted", "approved"]) assert.equal(render(lang, { review }), "");
    for (const status of ["DRAFT", "REGISTRATION_OPEN", "PAUSED", "COMPLETED", "ARCHIVED", "CANCELLED"])
      assert.equal(render(lang, {}, status), "");
  });
}
