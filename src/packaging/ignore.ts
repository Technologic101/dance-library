import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type PackagerHost = {
  platform: string;
  arch: string;
  musl?: boolean;
};

/** Keep Vite output, package.json, and the runtime dependency tree. Drop the toolchain. */
export function shouldPackagerIgnore(
  file: string,
  runtimePrefixes: readonly string[],
  host: PackagerHost = currentHost(),
): boolean {
  if (!file) return false;
  if (file === '/package.json' || file.startsWith('/.vite')) return false;
  if (isForeignNativeBinary(file, host)) return true;
  for (const prefix of runtimePrefixes) {
    if (file === prefix || file.startsWith(`${prefix}/`)) return false;
    // Parent directories have to be copied or the packager never descends into them.
    if (prefix.startsWith(`${file}/`)) return false;
  }
  return true;
}

function currentHost(): PackagerHost {
  return {
    platform: process.platform,
    arch: process.arch,
    musl: isLinuxMusl(),
  };
}

function isLinuxMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport?.() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

function hostBinaryId(host: PackagerHost): string {
  if (host.platform === 'linux' && host.musl) return `linuxmusl-${host.arch}`;
  return `${host.platform}-${host.arch}`;
}

function isForeignNativeBinary(file: string, host: PackagerHost): boolean {
  const sqlite = /\/better-sqlite3\/prebuilds\/([a-z0-9-]+)\.node$/.exec(file);
  if (sqlite) return sqlite[1] !== hostBinaryId(host);
  const ffprobe = /\/@ffprobe-installer\/([a-z0-9]+)-([a-z0-9]+)\//.exec(file);
  if (ffprobe) return ffprobe[1] !== host.platform || ffprobe[2] !== host.arch;
  return false;
}

export function runtimePackagePrefixes(projectRoot: string): string[] {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  const rootPkg = readPackage(path.join(projectRoot, 'package.json'));
  const prefixes = new Set<string>();
  const seen = new Set<string>();

  const visit = (name: string, fromDir: string) => {
    let pkgJsonPath: string;
    try {
      pkgJsonPath = require.resolve(`${name}/package.json`, { paths: [fromDir] });
    } catch {
      return;
    }
    const dir = path.dirname(pkgJsonPath);
    if (seen.has(dir)) return;
    seen.add(dir);
    const rel = path.relative(projectRoot, dir).split(path.sep).join('/');
    prefixes.add(`/${rel}`);
    const pkg = readPackage(pkgJsonPath);
    for (const dep of dependencyNames(pkg)) visit(dep, dir);
  };

  for (const dep of dependencyNames(rootPkg)) visit(dep, projectRoot);
  return [...prefixes];
}

function dependencyNames(pkg: PackageJson): string[] {
  return Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
}

function readPackage(pkgJsonPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
}
