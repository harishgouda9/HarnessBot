#!/usr/bin/env node
import { CATALOGS, LOCALES, REQUIRED_KEYS } from '../src/i18n.ts';

/**
 * Locale completeness. Missing keys are allowed — they fall back to English, which is
 * the honest shipped behaviour. What is *not* allowed is a key the English catalog
 * does not have (dead string), or a placeholder mismatch (renders as a literal brace).
 */

let failures = 0;
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const locale of LOCALES) {
  const catalog = CATALOGS[locale];
  if (!catalog) {
    console.log(`${locale.padEnd(6)} no overlay (falls back to English)`);
    continue;
  }

  for (const key of Object.keys(catalog)) {
    if (!REQUIRED_KEYS.includes(key)) {
      console.error(`FAIL ${locale}: "${key}" is not a key in the English catalog.`);
      failures++;
    } else if (placeholders(catalog[key]) !== placeholders(CATALOGS.en[key])) {
      console.error(`FAIL ${locale}: "${key}" placeholders differ from English.`);
      failures++;
    }
  }

  const covered = REQUIRED_KEYS.filter((k) => catalog[k]).length;
  const percent = Math.round((covered / REQUIRED_KEYS.length) * 100);
  console.log(`${locale.padEnd(6)} ${String(covered).padStart(3)}/${REQUIRED_KEYS.length} keys (${percent}%)`);
}

if (failures) {
  console.error(`\n${failures} locale problem(s).`);
  process.exit(1);
}
console.log('\nLocales OK. Missing keys fall back to English by design.');
