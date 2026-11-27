import assert from 'node:assert/strict';
import test from 'node:test';
import { learningReviewRecord } from '../src/pages/LiveLearningReview.tsx';
import type { Memory, RecordSnapshot } from '../../../packages/contracts/src/character-records.ts';
const record = {id:'memory-a',kind:'偏好',text:'偏好简短的欢迎。',status:'candidate',chatShare:false,source:'显式单轮学习',citation:'',version:'',revision:1,createdAt:'2026-11-27T00:00:00.000Z',updatedAt:'2026-11-27T00:00:00.000Z'} as unknown as Memory;
const snapshot = {schemaVersion:1,petID:'pet-a',revision:1,records:[record]} as RecordSnapshot<Memory>;
test('live review binds the candidate id and instance, never substitutes another memory',()=>{
 assert.equal(learningReviewRecord(snapshot,'pet-a','memory-a'),record);
 assert.equal(learningReviewRecord(snapshot,'pet-b','memory-a'),undefined);
 assert.equal(learningReviewRecord(snapshot,'pet-a','memory-other'),undefined);
 assert.equal(learningReviewRecord({...snapshot,records:[{...record,kind:'知识'}]},'pet-a','memory-a'),undefined);
});
