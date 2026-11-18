import type { CharactersBridge } from '../../../../packages/contracts/src/characters.ts';
import type { SpeechBridge } from '../../../../packages/contracts/src/speech.ts';
import { useEffect, useMemo, useState } from 'react';
import type { PetDefinition, WorkspaceData } from '../../../../packages/contracts/src/pets.ts';
import type { DiagnosticProps } from '../Diagnostics.tsx';
import { AdvancedPage } from './AdvancedPage.tsx';
import { GoalsPage, type GoalMode } from './GoalsPage.tsx';
import { IdentityPage } from './IdentityPage.tsx';
import { emptyIdentity, IdentityWorkspace } from './identity-editor.ts';
import { LivePage, emptyLive } from './LivePage.tsx';
import { MemoryPage } from './MemoryPage.tsx';
import { createGoalSession, createMemorySession, emptyGoal, emptyMemory, type MemoryMode } from './character-record-editors.ts';
import { RecordWorkspace } from './record-session.ts';
import { SpeechPage, emptySpeech } from './SpeechPage.tsx';
import type { Draft } from './WorkspacePanels.tsx';

type Module = 'identity' | 'memory' | 'goals' | 'speech' | 'live' | 'advanced';
function useDraft<T>(initial: T): Draft<T> {
  const [value, update] = useState<T>(initial);
  return { value, update };
}

/** Remains mounted across navigation; renders only the active module. */
export function WorkspaceModules({ page, workspace, diagnostics, speech, characters, selectedInstance }: { page: Module | null; workspace?: WorkspaceData; diagnostics: DiagnosticProps; speech?: SpeechBridge; characters?: CharactersBridge; selectedInstance?: Pick<PetDefinition, 'id' | 'displayName'> }) {
  const identity = useDraft(emptyIdentity);
  const identityWorkspace = useMemo(() => characters ? new IdentityWorkspace(characters) : undefined, [characters]);
  const memoryWorkspace = useMemo(() => characters ? new RecordWorkspace(id => createMemorySession(characters, id)) : undefined, [characters]);
  const goalsWorkspace = useMemo(() => characters ? new RecordWorkspace(id => createGoalSession(characters, id)) : undefined, [characters]);
  useEffect(() => {
    if (!workspace) return;
    const ids = workspace.instances.map(instance => instance.id);
    identityWorkspace?.keepRegistered(ids);
    memoryWorkspace?.keepRegistered(ids);
    goalsWorkspace?.keepRegistered(ids);
  }, [identityWorkspace, memoryWorkspace, goalsWorkspace, workspace]);
  const personal = useDraft(emptyMemory), knowledge = useDraft(emptyMemory);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>('personal');
  const goal = useDraft(emptyGoal);
  const [goalMode, setGoalMode] = useState<GoalMode>('capabilities');
  const speechDraft = useDraft(emptySpeech);
  const live = useDraft(emptyLive);
  switch (page) {
    case 'identity': return <IdentityPage key={selectedInstance?.id} draft={identity} connected={!!characters} instance={selectedInstance}
      editor={selectedInstance ? identityWorkspace?.forPet(selectedInstance.id) : undefined} />;
    case 'memory': return <MemoryPage key={selectedInstance?.id} mode={memoryMode} onMode={setMemoryMode} personal={personal} knowledge={knowledge} connected={!!characters}
      instance={selectedInstance} session={selectedInstance ? memoryWorkspace?.forPet(selectedInstance.id) : undefined} />;
    case 'goals': return <GoalsPage key={selectedInstance?.id} mode={goalMode} onMode={setGoalMode} draft={goal} workspace={workspace} connected={!!characters}
      instance={selectedInstance} session={selectedInstance && goalMode === 'plan' ? goalsWorkspace?.forPet(selectedInstance.id) : undefined} />;
    case 'speech': return <SpeechPage draft={speechDraft} bridge={speech} />;
    case 'live': return <LivePage draft={live} />;
    case 'advanced': return <AdvancedPage diagnostics={{ ...diagnostics, linkage: workspace?.linkage ?? 'active' }} />;
    case null: return null;
  }
}
