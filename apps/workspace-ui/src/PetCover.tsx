import { coverURL, dafeiyu, longmei, samePetPackage } from '../../../packages/contracts/src/built-in-pets.ts';
import { useState } from 'react';
import type { PackageReference } from '../../../packages/contracts/src/pets.ts';

// Only fixed in-app presentation assets; no catalog-provided path, URL, or style.
export function petArt(reference?: PackageReference): 'longmei' | 'dafeiyu' | 'default' {
  if (!reference) return 'default';
  return samePetPackage(reference, longmei) ? 'longmei' : samePetPackage(reference, dafeiyu) ? 'dafeiyu' : 'default';
}

export function PetCover({ reference, avatar = false }: { reference?: PackageReference; avatar?: boolean }) {
  const art = petArt(reference);
  return <Cover key={art} source={art === 'default' ? undefined : coverURL(art === 'longmei' ? longmei : dafeiyu)} avatar={avatar} />;
}

function Cover({ source, avatar }: { source?: string; avatar: boolean }) {
  const [status, setStatus] = useState<'pending' | 'loaded' | 'failed'>('pending');
  return <span className={`pet-cover${avatar ? ' pet-avatar' : ''}`} aria-hidden={avatar || undefined}>
    <span className="pet-cover-placeholder" hidden={status === 'loaded'}>
      <img src="./assets/app-icon.svg" alt="" draggable={false} />
      {!avatar && <small>封面暂不可用</small>}
    </span>
    {source && status !== 'failed' && <img src={source} alt={avatar ? '' : '桌宠封面'} draggable={false} decoding="async" className={status === 'loaded' ? 'loaded' : ''}
      onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
  </span>;
}
