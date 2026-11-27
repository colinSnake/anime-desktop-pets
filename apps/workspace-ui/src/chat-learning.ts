import { isCharacterLearningChatSelection, isCharacterLearningText } from '../../../packages/contracts/src/character-learning.ts';
import type { ChatHistoryTurn } from '../../../packages/contracts/src/chat-history.ts';

export function chatLearningSelection(petID:string,sessionID:string,turn:ChatHistoryTurn) {
  const selection={petID,sessionID,turnID:turn.requestID};
  if(isCharacterLearningChatSelection(selection)&&isCharacterLearningText(turn.user)&&isCharacterLearningText(turn.assistant))return selection;
}
