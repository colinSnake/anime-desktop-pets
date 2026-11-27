import assert from 'node:assert/strict';
import test from 'node:test';
import { chatLearningSelection } from '../src/chat-learning.ts';
const petID='pet-synthetic';
const session={id:'aaaabbbb-cccc-4ddd-8eee-ffffffffffff'};
const turn={requestID:'ffffbbbb-cccc-4ddd-8eee-ffffffffffff',completedAt:12000,user:'回复短一点就好',assistant:'好，我会简洁些。'};
test('chat selection sends only a single saved turn ID and never a copy of the exchange',()=>{
 assert.deepEqual(chatLearningSelection(petID,session.id,turn),{petID,sessionID:session.id,turnID:turn.requestID});
 assert.equal(chatLearningSelection(petID,session.id,{...turn,requestID:'local-draft'}),undefined);
 assert.equal(chatLearningSelection(petID,session.id,{...turn,user:'sk-proj-'+'a'.repeat(45)}),undefined);
 assert.equal(chatLearningSelection(petID,session.id,{...turn,user:'字'.repeat(1001)}),undefined);
});
