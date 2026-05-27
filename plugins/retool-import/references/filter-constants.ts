// Mirrors retool_development/packages/common/retoolReactAgent/appImportFileFilters.ts
// and appImportLimits.ts. Keep in sync if either changes.

export const SKIPPED_ZIP_DIRS = new Set([
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
  // macOS Finder / built-in `zip` writes AppleDouble resource-fork metadata
  // under a top-level `__MACOSX/` directory. Filtering it out keeps wrapper
  // detection accurate for Finder-compressed archives and avoids persisting
  // binary `._*` files into /imported-source.
  '__MACOSX',
])

export const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.md',
  '.txt',
  '.sql',
  '.toml',
  '.yaml',
  '.yml',
  '.svg',
  '.graphql',
  '.gql',
  '.sh',
  '.mjs',
  '.cjs',
  '.lock',
  '.prisma',
  '.xml',
  '.editorconfig',
])

// Dependency lockfiles. These are always regenerable from the corresponding
// manifest (package.json / Cargo.toml / etc.), often huge (100 KB – 5 MB),
// and the agent never needs their contents — resources are derived from the
// manifest, not the lock.
export const SKIPPED_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
])

// Minified bundles and source maps have no migratable content — they're
// generated from source and should never drive any agent decisions.
export const MINIFIED_OR_MAP_RE = /\.(min\.(?:js|mjs|cjs|css)|map)$/i

export function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : ''
}

// .env / .env.local are intentionally NOT included: they routinely contain
// API keys, DB passwords, and other secrets. .env.example is a documented
// convention for committed templates and is safe to include.
const EXTENSIONLESS_TEXT_FILENAMES = new Set([
  '.gitignore',
  '.eslintrc',
  '.prettierrc',
  'Dockerfile',
  'Makefile',
  '.env.example',
])

export function isTextFile(path: string): boolean {
  const ext = getFileExtension(path)
  if (TEXT_EXTENSIONS.has(ext)) return true
  const base = path.split('/').pop() ?? ''
  return EXTENSIONLESS_TEXT_FILENAMES.has(base)
}

export function shouldSkipZipEntry(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((part) => SKIPPED_ZIP_DIRS.has(part))) return true
  const base = parts[parts.length - 1] ?? ''
  if (SKIPPED_LOCKFILES.has(base)) return true
  if (MINIFIED_OR_MAP_RE.test(base)) return true
  return false
}

/** Per-file content size cap for imported source files (1 MiB). */
export const APP_IMPORT_MAX_FILE_BYTES = 1 * 1024 * 1024

/**
 * Aggregate cap for imported source files (50 MiB). On the frontend this
 * caps the .zip archive's on-disk size (a rough proxy for decompressed
 * total); on the backend this caps the decompressed payload as written
 * to tmpfs.
 */
export const APP_IMPORT_MAX_TOTAL_BYTES = 50 * 1024 * 1024

/**
 * Hard cap on file count in a single import_source_files payload.
 * Backend-only behavior — the frontend zip filter already drops
 * node_modules etc. before extraction.
 */
export const APP_IMPORT_MAX_FILE_COUNT = 5_000
