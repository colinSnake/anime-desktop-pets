import type { DesktopBridge } from '../../../../packages/contracts/src/index.ts';
import type { CharactersBridge } from '../../../../packages/contracts/src/characters.ts';
import type { SpeechBridge } from '../../../../packages/contracts/src/speech.ts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { PetAgentPanel, type AgentMemoryView, type CharacterPage } from './CharacterDataDialog.tsx';
import type { AgentChatAvailability } from './pet-agent-overview.ts';
import type { Draft } from './WorkspacePanels.tsx';

type Module = CharacterPage | 'agent' | 'speech' | 'live' | 'advanced';
function useDraft<T>(initial: T): Draft<T> {
  const [value, update] = useState<T>(initial);
  return { value, update };
}

/** Remains mounted across navigation; renders only the active module. */
export function WorkspaceModules({ page, workspace, diagnostics, speech, appearance, characters, selectedInstance, openWorkspaceData, migrateWorkspaceData, agent }: { agent?: { name: string; opener: HTMLElement; chat: AgentChatAvailability; onClose(): void }; page: Module | null; workspace?: WorkspaceData; diagnostics: DiagnosticProps; speech?: SpeechBridge; appearance?: ReactNode; characters?: CharactersBridge; openWorkspaceData?: DesktopBridge['openWorkspaceData']; migrateWorkspaceData?: DesktopBridge['migrateWorkspaceData']; selectedInstance?: Pick<PetDefinition, 'id' | 'displayName' | 'package'> }) {
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
  const dataPage = (section: CharacterPage, agentMemoryView?: AgentMemoryView) => {
    switch (section) {
    case 'identity': return <IdentityPage key={selectedInstance?.id} draft={identity} connected={!!characters} instance={selectedInstance}
      editor={selectedInstance ? identityWorkspace?.forPet(selectedInstance.id) : undefined} />;
    case 'memory': return <MemoryPage key={selectedInstance?.id} mode={agentMemoryView?.mode ?? memoryMode} onMode={agentMemoryView?.onMode ?? setMemoryMode} personal={personal} knowledge={knowledge} connected={!!characters}
      instance={selectedInstance} session={selectedInstance ? memoryWorkspace?.forPet(selectedInstance.id) : undefined} />;
    case 'goals': return <GoalsPage key={selectedInstance?.id} mode={agentMemoryView ? 'plan' : goalMode} onMode={setGoalMode} planOnly={!!agentMemoryView} draft={goal} workspace={workspace} connected={!!characters}
      instance={selectedInstance} session={selectedInstance && (agentMemoryView || goalMode === 'plan') ? goalsWorkspace?.forPet(selectedInstance.id) : undefined} />;
    }
  };
  switch (page) {
    case 'agent': return selectedInstance && agent ? <PetAgentPanel key={selectedInstance.id} {...agent} reference={selectedInstance.package}
      identity={identityWorkspace?.forPet(selectedInstance.id)} memory={memoryWorkspace?.forPet(selectedInstance.id)}
      goals={goalsWorkspace?.forPet(selectedInstance.id)} renderDetail={dataPage} /> : null;
    case 'identity': case 'memory': case 'goals': return dataPage(page);
    case 'speech': return <SpeechPage draft={speechDraft} bridge={speech} appearance={appearance} />;
    case 'live': return <LivePage draft={live} appearance={appearance} />;
    case 'advanced': return <AdvancedPage appearance={appearance} openWorkspaceData={openWorkspaceData} migrateWorkspaceData={migrateWorkspaceData} diagnostics={diagnostics} />;
    case null: return null;
  }
}
