import { useState } from 'react';
import type { PackageReference } from '../../../packages/contracts/src/pets.ts';

/** Only opaque catalog identity reaches the view; never a local path or URL input. */
export function PetCover({ reference }: { reference: PackageReference }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = reference.id === 'local.development.longmei' && reference.version === '0.0.0-dev';
  return <span className="pet-cover">
    <span className="pet-cover-placeholder" hidden={loaded && !failed}><span aria-hidden="true">◈</span><small>封面暂不可用</small></span>
    {supported && !failed && <img src="pet-app://workspace/covers/local.development.longmei/0.0.0-dev.png" alt="桌宠封面" decoding="async" className={loaded ? 'loaded' : ''} onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false); }} />}
  </span>;
}
