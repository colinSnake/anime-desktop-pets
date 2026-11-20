import { isAbsolute, join } from 'node:path';

export function resolveHarnessExecutable({
  platform,
  packaged,
  resourcesPath,
  environment,
}: {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  environment: NodeJS.ProcessEnv;
}): string | undefined {
  if (platform !== 'darwin') return undefined;
  if (packaged) {
    if (!isAbsolute(resourcesPath) || resourcesPath.includes('\0')) return undefined;
    return join(resourcesPath, '..', 'Helpers', 'pet-harness-node');
  }
  const candidate = environment.PET_HARNESS_NODE;
  if (!candidate || !isAbsolute(candidate) || candidate.includes('\0') || Buffer.byteLength(candidate) > 4096) return undefined;
  return candidate;
}
