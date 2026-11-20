import assert from 'node:assert/strict';
import { copyFile, cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HARNESS_VERSION } from './pet-sdk-runtime-version.mjs';

export { HARNESS_VERSION };
const sdk = '@deepseek-ai/dsh-sdk-client', cli = '@deepseek-ai/dsh', provider = '@deepseek-ai/dsh-llm-pi-ai';
const validName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const inside = (base, path) => {
  const suffix = relative(base, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const maxPackages = 1024, maxFiles = 120_000, maxBytes = 1024 ** 3;
// Audit these paths again before extending the experiment to another release.
const webSourceMaps = new Map([
  ['@deepseek-ai/dsh-web-frontend', /^dist\/assets\/[^/]+\.js\.map$/],
  ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview', /^lib\/client(?:\.(?:excel|frontmatter-fields|pdf))?\.js\.map$/],
]);

async function isAuditedWebSourceMap(pkg, dir, source) {
  if (pkg.version !== '0.2.2-rc.5') return false;
  const path = relative(dir, source).split(sep).join('/');
  if (!webSourceMaps.get(pkg.name)?.test(path) || /licen[cs]e|notice|copying/i.test(path)) return false;
  try { return (await lstat(source.slice(0, -4))).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Local verification only: clone the installed closure, not the reference project or global store. */
export async function stageHarnessRuntime(runtimePackage, destination) {
  return stageRuntime(runtimePackage, destination, false);
}

export async function stageProductHarnessRuntime(servicePackage, destination, { omitWebSourceMaps = false } = {}) {
  return stageRuntime(servicePackage, destination, true, omitWebSourceMaps);
}

async function stageRuntime(runtimePackage, destination, product, omitWebSourceMaps = false) {
  const reference = await realpath(resolve(runtimePackage, '../..'));
  const installed = join(reference, 'node_modules', '.pnpm');
  const store = await realpath(installed);
  assert.equal(store, installed, 'expected a reference-local pnpm virtual store');
  const output = resolve(await realpath(dirname(destination)), destination.split(sep).at(-1));
  assert(output !== reference && !inside(reference, output), 'stage must not write to reference checkout');
  const targetStore = join(output, 'node_modules', '.pnpm');
  const packages = new Map(), links = new Map();
  const atTarget = path => join(targetStore, relative(store, path));
  const lookup = async paths => {
    for (const path of paths) {
      try { return { path, real: await realpath(path) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  function addLink(path, real) {
    const dest = atTarget(real);
    if (path === dest) return;
    assert(!links.has(path) || links.get(path) === dest, 'conflicting dependency link');
    links.set(path, dest);
  }
  async function visit(real) {
    assert(inside(store, real), 'dependency outside installed store');
    if (packages.has(real)) return packages.get(real);
    const [slot, modules, ...components] = relative(store, real).split(sep);
    const name = components.join('/');
    assert(slot && slot !== 'node_modules' && modules === 'node_modules' && validName.test(name), 'unexpected pnpm package path');
    const manifest = join(real, 'package.json');
    const info = await lstat(manifest);
    assert(info.isFile() && info.size <= 256 * 1024, 'invalid installed package manifest');
    const data = JSON.parse(await readFile(manifest, 'utf8'));
    assert(packages.size < maxPackages, 'runtime stage package count exceeds bounds');
    assert(data.name === name && typeof data.version === 'string', `invalid installed package metadata: ${name}`);
    packages.set(real, data);
    const refs = Object.keys({ ...data.dependencies, ...data.optionalDependencies, ...data.peerDependencies });
    for (const dep of refs) {
      assert(validName.test(dep), 'invalid dependency name');
      const found = await lookup([join(real, 'node_modules', dep), join(store, slot, 'node_modules', dep), join(store, 'node_modules', dep)]);
      if (!found) {
        assert(Object.hasOwn(data.optionalDependencies ?? {}, dep) || data.peerDependenciesMeta?.[dep]?.optional === true, `missing required installed dependency: ${name} → ${dep}`);
        continue;
      }
      await visit(found.real);
      // Keep the package's pnpm resolution graph; nested .bin launch scripts are not used.
      addLink(atTarget(found.path), found.real);
    }
    return data;
  }
  for (const name of product ? [sdk, provider, 'fastify'] : [cli, sdk, provider]) {
    const direct = join(runtimePackage, 'node_modules', name);
    const found = await lookup(product ? [direct] : [direct, join(store, 'node_modules', name)]);
    assert(found, 'missing fixed Harness dependency');
    const pkg = await visit(found.real);
    assert(pkg.name === name && (name === 'fastify' || pkg.version === HARNESS_VERSION), 'unexpected Harness version');
    addLink(join(output, product ? 'apps/app-service/node_modules' : 'node_modules', name), found.real);
  }
  // Dynamic native/plugin loaders can resolve an already-collected package through
  // pnpm's hidden hoist directory. Rebuild only those links, never expand the closure.
  for (const name of new Set([...packages.values()].map(pkg => pkg.name))) {
    const found = await lookup([join(store, 'node_modules', name)]);
    if (found && packages.has(found.real)) addLink(atTarget(found.path), found.real);
  }
  await mkdir(output, { mode: 0o700 });
  let files = 0, bytes = 0, omittedFiles = 0, omittedBytes = 0;
  for (const [dir, pkg] of packages) {
    await cp(dir, atTarget(dir), { recursive: true, errorOnExist: true, force: false, filter: async source => {
      if (source === join(dir, 'node_modules')) return false;
      const info = await lstat(source);
      assert(info.isFile() || info.isDirectory(), 'unexpected package payload link or special file');
      if (info.isFile()) { files++; bytes += info.size; }
      assert(files <= maxFiles && bytes <= maxBytes, 'runtime stage payload exceeds bounds');
      if (omitWebSourceMaps && info.isFile() && await isAuditedWebSourceMap(pkg, dir, source)) {
        omittedFiles++;
        omittedBytes += info.size;
        return false;
      }
      return true;
    } });
  }
  for (const [path, target] of links) {
    await mkdir(dirname(path), { recursive: true });
    await symlink(relative(dirname(path), target), path);
  }
  if (!product) {
    for (const name of ['pet-sdk-runtime-worker.mjs', 'pet-sdk-runtime-version.mjs', 'pet-sdk-owner-channel.mjs', 'pet-sdk-probe-admission.mjs', 'pet-agent-harness-provider.mjs']) {
      await copyFile(new URL(name, import.meta.url), join(output, name));
    }
    await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'local-pet-sdk-stage', private: true, type: 'module' }), { flag: 'wx' });
  }
  return { packages: packages.size, payloadBytes: bytes - omittedBytes, payloadFiles: files - omittedFiles };
}
