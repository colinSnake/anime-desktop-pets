import type { ChatWorkspaceController } from './chat-session.ts';
import { canReloadMemory, memoryProposalError, type ChatMemoryProposal } from './chat-memory.ts';
import { PetNookIcon } from './PetNookIcon.tsx';

const messages = {
 reading: '正在读取本机记忆…',
 ready: '只有你确认后才会保存，不会分享给模型。',
 saving: '正在确认写入…',
 saved: '已记住 · 仅本机',
 ignored: '已忽略，未写入记忆。',
 uncertain: '写入结果未确认。请重读本机记忆核对，不会自动重发。',
 observed: '读到了这条记忆，但未收到持久写入确认。请在桌宠 Agent 中核对。',
 'not-observed': '没读到原样保存的记忆。结果仍未确认，这张卡不会重发。',
} as const;

export function ChatMemoryCard({ proposal, petID, messageID, name, controller }: {
 proposal: ChatMemoryProposal; petID: string; messageID: string; name: string; controller?: ChatWorkspaceController;
}) {
 const { state } = proposal;
 const reload = state === 'uncertain' || (state === 'blocked' && canReloadMemory(proposal.error));
 const ignore = state === 'ready' || state === 'blocked';
 return <section className="chat-memory-card" aria-label={`给${name}的记忆提案`}>
  <div className="chat-memory-heading"><PetNookIcon name="memory" /><strong>记忆提案</strong><span>{name}</span></div>
  <p className="chat-memory-text">{proposal.text}</p>
  <p className="chat-memory-status" role="status">{state === 'blocked' ? memoryProposalError[proposal.error] ?? '无法保存这条记忆。' : messages[state]}</p>
  {(ignore || reload) && <div className="chat-memory-actions">
   {state === 'ready' && <button type="button" className="chat-control chat-memory-save" disabled={!controller}
    onClick={() => { void controller?.saveMemoryProposal(petID, messageID); }}>保存为记忆</button>}
   {reload && <button type="button" className="chat-control" disabled={!controller}
    onClick={() => { void controller?.refreshMemoryProposal(petID, messageID); }}>重新读取记忆</button>}
   {ignore && <button type="button" className="chat-control" disabled={!controller}
    onClick={() => controller?.ignoreMemoryProposal(petID, messageID)}>忽略</button>}
  </div>}
 </section>;
}
