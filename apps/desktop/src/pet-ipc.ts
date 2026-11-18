import { isPetInput, type PetAction } from '../../../packages/contracts/src/pets.ts';
export type PetMethod = 'list' | PetAction;
export function validPetArgs(method: PetMethod, args: unknown[]): boolean {
  return method === 'list' ? args.length === 0 : args.length === 1 && isPetInput(method, args[0]);
}
export function validPackagePickerArgs(args: unknown[]): boolean { return args.length === 0; }
