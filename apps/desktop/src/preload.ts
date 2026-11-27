import { characterLearningIPC } from '../../../packages/contracts/src/character-learning-ipc.ts';
import { liveChannel } from '../../../packages/contracts/src/live-stage.ts';
import { contextBridge, ipcRenderer } from "electron";
import { microphoneIPC, voiceDraftIPC } from '../../../packages/contracts/src/voice-draft.ts';
import type { DesktopBridge } from "../../../packages/contracts/src/index.ts";

import { MicrophoneCapture } from './microphone-capture.ts';
import { openMicrophone } from './microphone-device.ts';
import { MicrophoneGesture } from './microphone-gesture.ts';

const microphone = process.platform === 'darwin' && process.arch === 'arm64' && process.isMainFrame === true
  ? new MicrophoneCapture({
    arm: () => ipcRenderer.invoke(microphoneIPC.arm),
    started: id => ipcRenderer.invoke(microphoneIPC.started, id),
    cancel: id => ipcRenderer.invoke(microphoneIPC.cancel, id),
    finish: (id, audio) => ipcRenderer.invoke(microphoneIPC.finish, id, audio),
  }, openMicrophone) : undefined;
const microphoneGesture = microphone ? new MicrophoneGesture(window) : undefined;
const noMicGesture = Promise.resolve({ ok: false, error: 'cancelled' } as const);
if (microphone) ipcRenderer.on(microphoneIPC.revoked, (_event, id) => microphone.revoked(id));

const bridge: DesktopBridge = Object.freeze({
  ...(process.platform === 'darwin' ? { characterLearning: Object.freeze({
    selectChatTurn: input => ipcRenderer.invoke(characterLearningIPC.selectChatTurn,input),
    preview: input => ipcRenderer.invoke(characterLearningIPC.preview,input),
    generate: input => ipcRenderer.invoke(characterLearningIPC.generate,input),
    cancel: input => ipcRenderer.invoke(characterLearningIPC.cancel,input),
  } satisfies NonNullable<DesktopBridge['characterLearning']>) } : {}),
  ...(process.platform === 'darwin' ? {
    legacyCharacterHandoff: (input: Parameters<NonNullable<DesktopBridge['legacyCharacterHandoff']>>[0]) => ipcRenderer.invoke('pet:legacy-character-handoff', input),
  } : {}),
  ...(process.platform === 'darwin' ? { characters: Object.freeze({
    readIdentity: input => ipcRenderer.invoke('pet:characters-readIdentity', input),
    saveIdentity: input => ipcRenderer.invoke('pet:characters-saveIdentity', input),
    restoreIdentity: input => ipcRenderer.invoke('pet:characters-restoreIdentity', input),
    setIdentityChatShare: input => ipcRenderer.invoke('pet:characters-setIdentityChatShare', input),
    localChatContext: input => ipcRenderer.invoke('pet:characters-localChatContext', input),
    searchKnowledge: input => ipcRenderer.invoke('pet:characters-searchKnowledge', input),
    readMemories: input => ipcRenderer.invoke('pet:characters-readMemories', input),
    readMemoryHistory: input => ipcRenderer.invoke('pet:characters-readMemoryHistory', input),
    editMemory: input => ipcRenderer.invoke('pet:characters-editMemory', input),
    restoreMemory: input => ipcRenderer.invoke('pet:characters-restoreMemory', input),
    selectKnowledgeFile: () => ipcRenderer.invoke('pet:characters-selectKnowledgeFile'),
    addKnowledgeBatch: input => ipcRenderer.invoke('pet:characters-addKnowledgeBatch', input),
    saveChatMemory: input => ipcRenderer.invoke('pet:characters-saveChatMemory', input),
    addMemory: input => ipcRenderer.invoke('pet:characters-addMemory', input),
    confirmMemory: input => ipcRenderer.invoke('pet:characters-confirmMemory', input),
    withdrawMemory: input => ipcRenderer.invoke('pet:characters-withdrawMemory', input),
    deleteMemory: input => ipcRenderer.invoke('pet:characters-deleteMemory', input),
    setMemoryChatShare: input => ipcRenderer.invoke('pet:characters-setMemoryChatShare', input),
    readGoals: input => ipcRenderer.invoke('pet:characters-readGoals', input),
    addGoal: input => ipcRenderer.invoke('pet:characters-addGoal', input),
    editGoal: input => ipcRenderer.invoke('pet:characters-editGoal', input),
    deleteGoal: input => ipcRenderer.invoke('pet:characters-deleteGoal', input),
    setGoalChatShare: input => ipcRenderer.invoke('pet:characters-setGoalChatShare', input),
  } satisfies NonNullable<DesktopBridge['characters']>) } : {}),
  ...(process.platform === 'darwin' ? { liveStage: Object.freeze({
    read: role => ipcRenderer.invoke(liveChannel('read'),role),
    save: (profile,role) => ipcRenderer.invoke(liveChannel('save'), profile,role),
    switchScene: (scene,role) => ipcRenderer.invoke(liveChannel('switchScene'), scene,role),
    start: role => ipcRenderer.invoke(liveChannel('start'),role),
    stop: role => ipcRenderer.invoke(liveChannel('stop'),role),
    preview: role => ipcRenderer.invoke(liveChannel('preview'),role),
    copy: role => ipcRenderer.invoke(liveChannel('copy'),role),
    trigger: (action,role) => ipcRenderer.invoke(liveChannel('trigger'), action,role),
    submitDanmaku: (text,role) => ipcRenderer.invoke(liveChannel('submitDanmaku'),text,role),
    stopDanmaku: role => ipcRenderer.invoke(liveChannel('stopDanmaku'),role),
    voiceProfile: Object.freeze({
      read: input => ipcRenderer.invoke('pet:live-voice-profile-read',input),
      selectReference: input => ipcRenderer.invoke('pet:live-voice-profile-select-reference',input),
      saveTranscript: input => ipcRenderer.invoke('pet:live-voice-profile-transcript',input),
      clearReference: input => ipcRenderer.invoke('pet:live-voice-profile-clear-reference',input),
    }),
    learning: Object.freeze({
      preview: input => ipcRenderer.invoke(characterLearningIPC.preview,input),
      generate: input => ipcRenderer.invoke(characterLearningIPC.generate,input),
      cancel: input => ipcRenderer.invoke(characterLearningIPC.cancel,input),
    }),
    readShares: role => ipcRenderer.invoke('pet:live-shares-read',role),
    writeShares: input => ipcRenderer.invoke('pet:live-shares-write',input),
    readBindings: () => ipcRenderer.invoke('pet:live-role-bindings-read'),
    writeBinding: input => ipcRenderer.invoke('pet:live-role-bindings-write',input),
  } satisfies NonNullable<DesktopBridge['liveStage']>) } : {}),
  ...(process.platform === 'darwin' ? { agentTasks: Object.freeze({
    list: input => ipcRenderer.invoke('pet:agent-tasks-list', input),
    read: input => ipcRenderer.invoke('pet:agent-tasks-read', input),
    cancel: input => ipcRenderer.invoke('pet:agent-tasks-cancel', input),
  } satisfies NonNullable<DesktopBridge['agentTasks']>) } : {}),
  ...(process.platform === 'darwin' ? { chatProjects: Object.freeze({
    list: input => ipcRenderer.invoke('pet:chat-project-list', input),
    create: input => ipcRenderer.invoke('pet:chat-project-create', input),
  } satisfies NonNullable<DesktopBridge['chatProjects']>) } : {}),
  ...(process.platform === 'darwin' ? { chatHistory: Object.freeze({
    list: input => ipcRenderer.invoke('pet:chat-history-list', input),
    detail: input => ipcRenderer.invoke('pet:chat-history-detail', input),
    clear: input => ipcRenderer.invoke('pet:chat-history-clear', input),
  } satisfies NonNullable<DesktopBridge['chatHistory']>) } : {}),
  ...(process.platform === 'darwin' ? { onlineChat: Object.freeze({
    list: () => ipcRenderer.invoke('pet:chat-models'),
    send: input => ipcRenderer.invoke('pet:chat-send', input),
    approveMaterials: input => ipcRenderer.invoke('pet:chat-approve-materials', input),
    cancel: async id => { await ipcRenderer.invoke('pet:chat-cancel', id); },
  } satisfies NonNullable<DesktopBridge['onlineChat']>) } : {}),
  ...(process.platform === 'darwin' ? { models: Object.freeze({
    list: () => ipcRenderer.invoke('pet:models-list'),
    save: input => ipcRenderer.invoke('pet:models-save', input),
    setDefault: input => ipcRenderer.invoke('pet:models-default', input),
    remove: input => ipcRenderer.invoke('pet:models-remove', input),
    discover: input => ipcRenderer.invoke('pet:models-discover', input),
    cancelDiscovery: async id => { await ipcRenderer.invoke('pet:models-cancel-discovery', id); },
    testConnection: input => ipcRenderer.invoke('pet:models-test-connection', input),
    cancelConnectionTest: async id => { await ipcRenderer.invoke('pet:models-cancel-connection-test', id); },
  } satisfies NonNullable<DesktopBridge['models']>) } : {}),
  ...(microphone ? { voiceDraft: Object.freeze({
    select: () => ipcRenderer.invoke(voiceDraftIPC.select),
    cancel: async () => { await ipcRenderer.invoke(voiceDraftIPC.cancel); },
    microphone: Object.freeze({
      authorize: () => microphoneGesture?.take('authorize') ? ipcRenderer.invoke(microphoneIPC.authorize) : noMicGesture,
      start: (interrupted: () => void) => microphoneGesture?.take('start')
        ? microphone.start(typeof interrupted === 'function' ? interrupted : undefined) : noMicGesture,
      stop: () => microphone.stop(),
      cancel: () => microphone.cancel(),
    }),
  } satisfies NonNullable<DesktopBridge['voiceDraft']>) } : {}),
  ...(process.platform === 'darwin' && process.arch === 'arm64' ? { speech: Object.freeze({
    preview: () => ipcRenderer.invoke('pet:speech-preview'),
    stopPreview: () => ipcRenderer.invoke('pet:speech-stopPreview'),
    status: () => ipcRenderer.invoke('pet:speech-status'),
    selectReference: () => ipcRenderer.invoke('pet:speech-selectReference'),
    clearReference: () => ipcRenderer.invoke('pet:speech-clearReference'),
    saveTranscript: input => ipcRenderer.invoke('pet:speech-saveTranscript', input),
    enable: input => ipcRenderer.invoke('pet:speech-enable', input),
    disable: () => ipcRenderer.invoke('pet:speech-disable'),
  } satisfies NonNullable<DesktopBridge['speech']>) } : {}),
  pets: Object.freeze({
    list: () => ipcRenderer.invoke("pet:pets-list"),
    importPackages: () => ipcRenderer.invoke('pet:pets-importPackages'),
    start: (input) => ipcRenderer.invoke("pet:pets-start", input),
    stop: (input) => ipcRenderer.invoke("pet:pets-stop", input),
    applyDisplayPreferences: (input) => ipcRenderer.invoke("pet:pets-applyDisplay", input),
    applyBehaviorPreferences: (input) => ipcRenderer.invoke("pet:pets-applyBehavior", input),
    setVisible: (input) => ipcRenderer.invoke("pet:pets-visibility", input),
    add: (input) => ipcRenderer.invoke("pet:pets-add", input),
    clone: (input) => ipcRenderer.invoke("pet:pets-clone", input),
    delete: (input) => ipcRenderer.invoke("pet:pets-delete", input),
    save: (input) => ipcRenderer.invoke("pet:pets-save", input),
    setTheme: (input) => ipcRenderer.invoke("pet:pets-theme", input),
    pause: (input) => ipcRenderer.invoke("pet:pets-pause", input),
    resume: (input) => ipcRenderer.invoke("pet:pets-resume", input),
  } satisfies NonNullable<DesktopBridge["pets"]>),
  ...(process.platform === 'darwin' ? { migrateWorkspaceData: () => ipcRenderer.invoke('pet:migrate-workspace-data') } : {}),
  openWorkspaceData: () => ipcRenderer.invoke("pet:open-workspace-data"),
  snapshot: () => ipcRenderer.invoke("pet:snapshot"),
  probeRuntime: () => ipcRenderer.invoke("pet:probe-runtime"),
});
contextBridge.exposeInMainWorld("petDesktop", bridge);
