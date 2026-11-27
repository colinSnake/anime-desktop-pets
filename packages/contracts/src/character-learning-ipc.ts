/** Fixed channel names for the sandboxed preload; keep this module dependency-free. */
export const characterLearningIPC = {
  selectChatTurn: 'pet:character-learning-select-chat-turn', preview: 'pet:character-learning-preview', generate: 'pet:character-learning-generate', cancel: 'pet:character-learning-cancel',
} as const;
