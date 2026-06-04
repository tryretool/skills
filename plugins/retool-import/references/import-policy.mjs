#!/usr/bin/env node
// Mirrors retool_development/packages/common/retoolReactAgent/appImportClassifier/
// rules.ts and classifier.ts. Keep the signal lists, bucket tables, and
// `mapToVerdict` in sync if either changes upstream.
//
// This is the deterministic, pre-agent compatibility classifier. It runs
// LOCALLY in the retool-import skills so a hard-no app type is blocked before
// anything is handed to Retool's R2 agent. It looks ONLY at manifest files
// (package.json / app.json / config-file presence) — never at source code.
//
// Layering (same as the browser import widget):
//   - Hard-No  -> block locally; the app type isn't supported.
//   - Next.js  -> Soft-No carve-out; the skill asks the user to confirm a
//                 best-effort import (see `localGateVerdict`).
//   - anything else -> pass; the R2 agent's `evaluate_app_compatibility`
//                 tool remains the second line of defense for combinations
//                 the manifest layer can't see (the non-skills fallback).
//
// Usage (from a skill):
//   node <plugin>/references/import-policy.mjs <repo-root>
// Prints one line of JSON: { verdict, identifiedAs, reasons }.

import { promises as fs } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Match helpers (mirror rules.ts)
// ---------------------------------------------------------------------------

/** @typedef {{ path: string, content: string }} ImportedFile */
/** @typedef {{ label: string, match: (file: ImportedFile) => boolean }} Signal */

export const basenameOf = (p) => p.split('/').pop() ?? ''

const basename = (name) => (file) => basenameOf(file.path) === name

const basenameRegex = (re) => (file) => re.test(basenameOf(file.path))

/**
 * True when `package.json` contains `name` in `dependencies`,
 * `devDependencies`, or `peerDependencies`. Tolerates malformed JSON.
 */
const packageHasDep = (file, name) => {
  if (basenameOf(file.path) !== 'package.json') return false
  let parsed
  try {
    parsed = JSON.parse(file.content)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = parsed[key]
    if (typeof deps === 'object' && deps !== null && name in deps) return true
  }
  return false
}

/**
 * True when a JSON file at `name` parses and has `key` at the top level. Used
 * to disambiguate ambiguous filenames (e.g. `app.json` is only Expo's
 * manifest when it has an `expo` key).
 */
const jsonHasTopLevelKey = (file, name, key) => {
  if (basenameOf(file.path) !== name) return false
  try {
    const parsed = JSON.parse(file.content)
    return typeof parsed === 'object' && parsed !== null && key in parsed
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Signal lists (mirror rules.ts). Tight (file presence / JSON shape) first,
// loose (`packageHasDep` fallbacks) second — precedence is structural.
// ---------------------------------------------------------------------------

/** @type {readonly Signal[]} */
export const MOBILE_FILE_SIGNALS = [
  { label: 'Expo', match: (f) => jsonHasTopLevelKey(f, 'app.json', 'expo') },
  { label: 'Flutter', match: basename('pubspec.yaml') },
  { label: 'native iOS code', match: basename('Podfile') },
  { label: 'native Android code', match: basename('AndroidManifest.xml') },
  { label: 'Capacitor', match: basenameRegex(/^capacitor\.config\.(?:ts|js|mjs|cjs|json)$/) },
  { label: 'Ionic', match: basename('ionic.config.json') },
  { label: 'NativeScript', match: basenameRegex(/^nativescript\.config\.(?:ts|js)$/) },
]

/** @type {readonly Signal[]} */
export const MOBILE_DEP_SIGNALS = [
  // Catches RN zips that don't ship native folders. Expo wins above when its
  // `app.json` shape is present.
  { label: 'React Native', match: (f) => packageHasDep(f, 'react-native') },
]

export const MOBILE_SIGNALS = [...MOBILE_FILE_SIGNALS, ...MOBILE_DEP_SIGNALS]

/** @type {readonly Signal[]} */
export const HARD_NO_FILE_SIGNALS = [
  { label: 'Python', match: basename('pyproject.toml') },
  { label: 'Go', match: basename('go.mod') },
  { label: 'Ruby', match: basename('Gemfile') },
  { label: 'Java', match: basename('pom.xml') },
  { label: 'Java', match: basename('build.gradle') },
  { label: 'Java', match: basename('build.gradle.kts') },
  { label: '.NET', match: basenameRegex(/\.csproj$/) },
  { label: 'Rust', match: basename('Cargo.toml') },
  { label: 'PHP', match: basename('composer.json') },
  // Meta-frameworks (Next.js has its own carve-out below)
  { label: 'Nuxt', match: basenameRegex(/^nuxt\.config\.(?:ts|js|mjs|cjs)$/) },
  { label: 'Angular', match: basename('angular.json') },
  { label: 'SvelteKit', match: basenameRegex(/^svelte\.config\.(?:ts|js|mjs|cjs)$/) },
  { label: 'Gatsby', match: basenameRegex(/^gatsby-config\.(?:ts|js|mjs|cjs)$/) },
  { label: 'Astro', match: basenameRegex(/^astro\.config\.(?:ts|js|mjs|cjs)$/) },
  { label: 'Remix', match: basenameRegex(/^remix\.config\.(?:ts|js|mjs|cjs)$/) },
]

/** @type {readonly Signal[]} */
export const HARD_NO_DEP_SIGNALS = [
  // Bare frontend frameworks that ship as a `package.json` dep with no
  // canonical config file
  { label: 'Vue', match: (f) => packageHasDep(f, 'vue') },
  { label: 'Svelte', match: (f) => packageHasDep(f, 'svelte') },
  { label: 'Angular', match: (f) => packageHasDep(f, '@angular/core') },
  { label: 'Solid.js', match: (f) => packageHasDep(f, 'solid-js') },
  { label: 'Qwik', match: (f) => packageHasDep(f, '@builder.io/qwik') },
  { label: 'Lit', match: (f) => packageHasDep(f, 'lit') },
  { label: 'Preact', match: (f) => packageHasDep(f, 'preact') },
]

export const HARD_NO_SIGNALS = [...HARD_NO_FILE_SIGNALS, ...HARD_NO_DEP_SIGNALS]

/**
 * Next.js detection — Hard-No carve-out. When matched (and nothing mobile
 * matched first), the non-mobile Hard-No block is skipped: Next.js is a
 * Soft-No, surfaced to the user as a best-effort confirm.
 * @type {readonly Signal[]}
 */
export const NEXTJS_SIGNALS = [
  { label: 'Next.js', match: basenameRegex(/^next\.config\.(?:ts|js|mjs|cjs)$/) },
  { label: 'Next.js', match: (f) => packageHasDep(f, 'next') },
]

// ---------------------------------------------------------------------------
// Verdict mapping (mirror rules.ts)
// ---------------------------------------------------------------------------

/**
 * Maps coarse buckets to the policy verdict. Polyglot rule: strictest of
 * frontend/backend wins. Mobile in either bucket is Hard-No. `other` in
 * either bucket is Hard-No, except when Next.js is present — the carve-out
 * yields Soft-No.
 * @param {'supported'|'mobile'|'other'|'nextjs'|'none'} frontend
 * @param {'supported'|'mobile'|'other'|'nextjs'|'none'} backend
 * @returns {'supported'|'soft_no'|'hard_no'}
 */
export function mapToVerdict(frontend, backend) {
  if (frontend === 'mobile' || backend === 'mobile') return 'hard_no'
  if (frontend === 'nextjs' || backend === 'nextjs') return 'soft_no'
  if (frontend === 'other' || backend === 'other') return 'hard_no'
  return 'supported'
}

// ---------------------------------------------------------------------------
// User-facing copy (mirror rules.ts)
// ---------------------------------------------------------------------------

/** Public docs page listing supported import frameworks / stacks. */
export const R2_IMPORT_DOCS_URL = 'https://docs.retool.com/build/apps/guides/import'

/** Hard-No message (parity with `agentHardNoBody`). */
export const hardNoBody = (identifiedAs) =>
  `Your app uses ${identifiedAs}, which isn't supported yet. ` +
  `Try a different app, or see supported frameworks: ${R2_IMPORT_DOCS_URL}`

/** Soft-No confirm title (parity with `softNoTitle`). */
export const softNoTitle = (identifiedAs) => `${identifiedAs} imports are not supported`

/** Soft-No confirm body (parity with `softNoBody`). */
export const softNoBody = (identifiedAs) =>
  `We're still learning how to handle ${identifiedAs}. ` +
  `We'll attempt the build, but the result may need some cleanup.`

// ---------------------------------------------------------------------------
// Classifier (mirror classifier.ts)
// ---------------------------------------------------------------------------

/** @param {readonly Signal[]} signals @param {readonly ImportedFile[]} files */
function findMatch(signals, files) {
  for (const file of files) {
    for (const signal of signals) {
      if (signal.match(file)) return { signal, file }
    }
  }
  return null
}

const anyMatches = (signals, files) => findMatch(signals, files) !== null

function findMatchInGroups(groups, files) {
  for (const group of groups) {
    const hit = findMatch(group, files)
    if (hit) return hit
  }
  return null
}

/**
 * Faithful port of R2's pre-agent `classifyImportedApp`. Returns `pass` or
 * `hard_no`; Next.js falls through to `pass` (carve-out).
 * @param {Iterable<ImportedFile>} files
 * @returns {{ verdict: 'pass'|'hard_no', identifiedAs: string, reasons: string[] }}
 */
export function classifyImportedApp(files) {
  const fileArray = Array.from(files)

  const mobile = findMatchInGroups([MOBILE_FILE_SIGNALS, MOBILE_DEP_SIGNALS], fileArray)
  if (mobile) {
    return {
      verdict: 'hard_no',
      identifiedAs: mobile.signal.label,
      reasons: [`${mobile.signal.label} via ${basenameOf(mobile.file.path)}`],
    }
  }

  if (anyMatches(NEXTJS_SIGNALS, fileArray)) {
    return { verdict: 'pass', identifiedAs: '', reasons: [] }
  }

  const hardNoHit = findMatchInGroups([HARD_NO_FILE_SIGNALS, HARD_NO_DEP_SIGNALS], fileArray)
  if (hardNoHit) {
    return {
      verdict: 'hard_no',
      identifiedAs: hardNoHit.signal.label,
      reasons: [`${hardNoHit.signal.label} via ${basenameOf(hardNoHit.file.path)}`],
    }
  }

  return { verdict: 'pass', identifiedAs: '', reasons: [] }
}

/**
 * Local three-way gate. Reuses the faithful `classifyImportedApp` and then
 * splits its `pass` into `soft_no` (Next.js carve-out matched) vs `supported`.
 * This is what the skills act on: hard_no blocks, soft_no prompts a
 * best-effort confirm, supported proceeds.
 * @param {Iterable<ImportedFile>} files
 * @returns {{ verdict: 'hard_no'|'soft_no'|'supported', identifiedAs: string, reasons: string[] }}
 */
export function localGateVerdict(files) {
  const fileArray = Array.from(files)
  const base = classifyImportedApp(fileArray)
  if (base.verdict === 'hard_no') return base

  const nextjs = findMatch(NEXTJS_SIGNALS, fileArray)
  if (nextjs) {
    return {
      verdict: 'soft_no',
      identifiedAs: nextjs.signal.label,
      reasons: [`${nextjs.signal.label} via ${basenameOf(nextjs.file.path)}`],
    }
  }

  return { verdict: 'supported', identifiedAs: '', reasons: [] }
}

// ---------------------------------------------------------------------------
// CLI — walk a repo root, gather manifest files, print the gate verdict.
// ---------------------------------------------------------------------------

// Mirror of SKIPPED_ZIP_DIRS in filter-constants.ts — never descend into
// these. Build output and vendored deps can't change the app's type.
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.vite',
  '.cache',
  '.turbo',
  'coverage',
  '.expo',
  '__pycache__',
  '__MACOSX',
])

// Only these manifests are ever inspected for *content*. Everything else is
// matched by path/basename alone, so we record path + empty content.
const CONTENT_BASENAMES = new Set(['package.json', 'app.json'])

/** Recursively collect { path, content } for files that a signal could match. */
async function collectFiles(root) {
  /** @type {ImportedFile[]} */
  const out = []
  async function walk(absDir, relDir) {
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        await walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name)
      } else if (entry.isFile()) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        let content = ''
        if (CONTENT_BASENAMES.has(entry.name)) {
          try {
            content = await fs.readFile(path.join(absDir, entry.name), 'utf8')
          } catch {
            content = ''
          }
        }
        out.push({ path: rel, content })
      }
    }
  }
  await walk(root, '')
  return out
}

async function main() {
  const root = process.argv[2] ?? process.cwd()
  const files = await collectFiles(path.resolve(root))
  const result = localGateVerdict(files)
  process.stdout.write(JSON.stringify(result) + '\n')
}

// Run as CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`import-policy: ${err?.message ?? String(err)}\n`)
    process.exit(2)
  })
}
