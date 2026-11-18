import { credentialLikeText, type Goal } from '../../../../packages/contracts/src/character-records.ts';
import type { Identity } from '../../../../packages/contracts/src/characters.ts';

export function chatIdentity({ name, role, personality, speakingStyle, boundaries }: Identity) {
  return { name, role, personality, speakingStyle, boundaries };
}

export function chatGoal(goal: Goal) {
  return { title: goal.title, status: goal.status, completed: goal.steps.filter(step => step.isComplete).length, total: goal.steps.length };
}

export const safeChatFields = (fields: readonly string[]) => !credentialLikeText(fields.join(' '));
