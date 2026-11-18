import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import type { CatalogEntry, PackageReference } from '../../../packages/contracts/src/pets.ts';

type ToolResult = { ok: true; packages?: PackageReference[]; pets?: unknown[] } | { ok: false };
type Invoke = (request: Record<string, unknown>) => Promise<ToolResult>;

function validReference(value: unknown): value is PackageReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && typeof item.id === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(item.id) &&
    typeof item.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version);
}

function safeName(path: string) {
  const value = basename(path).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 255);
  return value && value !== '.' && value !== '..' ? value : '未命名素材';
}

function invokePython(options: { python?: string; scriptPath: string }, request: Record<string, unknown>): Promise<ToolResult> {
  return new Promise(resolve => {
    const executable = options.python ?? (process.platform === 'win32' ? 'python' : 'python3');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    let child;
    try { child = spawn(executable, ['-u', options.scriptPath], { cwd: dirname(options.scriptPath), env, shell: false, windowsHide: true, stdio: 'pipe' }); }
    catch { resolve({ ok: false }); return; }
    let stdout = Buffer.alloc(0), invalid = false, settled = false;
    const finish = (value: ToolResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { invalid = true; child.kill(); finish({ ok: false }); }, 120_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 64 * 1024) { invalid = true; child.kill(); finish({ ok: false }); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.resume();
    child.on('error', () => finish({ ok: false }));
    child.stdin.on('error', () => finish({ ok: false }));
    child.on('close', code => {
      if (invalid || code !== 0) { finish({ ok: false }); return; }
      try {
        const value: unknown = JSON.parse(stdout.toString('utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value) && (value as { ok?: unknown }).ok === true) finish(value as ToolResult);
        else finish({ ok: false });
      } catch { finish({ ok: false }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** 固定调用现有离线素材工具；路径仅存在于主进程与本地服务之间。 */
export class PetPackageImporter {
  private readonly packageRoot: string;
  private invoke: Invoke;
  constructor(options: { root: string; scriptPath: string; python?: string; invoke?: Invoke }) {
    if (!isAbsolute(options.root) || !isAbsolute(options.scriptPath)) throw new Error('invalid_package_importer');
    this.packageRoot = `${options.root.replace(/[\\/]$/, '')}/pet-library`;
    this.invoke = options.invoke ?? (request => invokePython(options, request));
  }
  async listCatalog(): Promise<CatalogEntry[]> {
    const result = await this.invoke({ operation: 'scan', paths: [`${this.packageRoot}/packages`] });
    if (!result.ok || !Array.isArray(result.pets)) return [];
    const entries: CatalogEntry[] = [];
    for (const value of result.pets) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const reference = { id: row.id, version: row.version };
      if (validReference(reference) && typeof row.name === 'string' && row.name.trim().length > 0 && [...row.name].length <= 80) {
        entries.push({ ...reference, name: row.name, launchable: false });
      }
      if (entries.length === 32) break;
    }
    return entries;
  }
  async importOne(path: string): Promise<{ name: string; package: CatalogEntry }> {
    const name = safeName(path);
    const prepared = await this.invoke({ operation: 'prepare', paths: [path], library: this.packageRoot });
    if (!prepared.ok || !Array.isArray(prepared.packages) || prepared.packages.length !== 1 || !validReference(prepared.packages[0])) throw new Error('package_import_failed');
    const reference = prepared.packages[0];
    const catalog = await this.listCatalog();
    const entry = catalog.find(item => item.id === reference.id && item.version === reference.version);
    if (!entry) throw new Error('package_import_failed');
    return { name, package: entry };
  }
}
