import type { PackageReference } from '../../../packages/contracts/src/pets.ts';
import { PetCover } from './PetCover.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';

type RoleOption = { id: string; name: string; detail?: string };

export function PetRolePicker({ label, options, selected, reference, description, onChange }: {
  label: string; options: readonly RoleOption[]; selected: RoleOption; reference?: PackageReference;
  description?: string; onChange?(id: string): void;
}) {
  const canChoose = options.length > 1;
  return <div className="pet-role-picker">
    <span className="pet-role-avatar"><PetCover reference={reference} avatar /></span>
    <span className="pet-role-name" aria-hidden={canChoose || undefined}>{selected.name}</span>
    {canChoose && <><PetNookIcon name="down" /><select aria-label={label} aria-describedby={description} title={selected.name}
      value={selected.id} disabled={!onChange} onChange={event => onChange?.(event.currentTarget.value)}>
      {options.map(item => <option key={item.id} value={item.id}>{item.detail ? `${item.name} · ${item.detail}` : item.name}</option>)}
    </select></>}
  </div>;
}
