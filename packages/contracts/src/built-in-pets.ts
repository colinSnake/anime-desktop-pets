import type { PackageReference } from './pets.ts';

export const longmei = { id: 'local.development.longmei', version: '0.0.0-dev' } as const;
export const dafeiyu = { id: 'local.community.dafeiyu', version: '0.0.0-dev' } as const;
export const samePetPackage = (a: PackageReference, b: PackageReference) => a.id === b.id && a.version === b.version;
export const isDafeiyu = (value: PackageReference) => samePetPackage(value, dafeiyu);
export const coverURL = (pet: PackageReference) => `pet-app://workspace/covers/${pet.id}/${pet.version}.png`;
