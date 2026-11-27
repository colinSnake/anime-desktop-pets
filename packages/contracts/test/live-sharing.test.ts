import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveSharingInput, isLiveSharingResult } from '../src/live-sharing.ts';
const record = {kind:'identity',recordID:'identity',recordRevision:1} as const;
const input = {role:'longmei',petID:'pet-synthetic',bindingRevision:1,expectedRevision:0,records:[record]};
test('live sharing input pins the displayed binding and versions and rejects extra capabilities', () => {
  assert.equal(isLiveSharingInput(input),true);
  for (const value of [{...input,role:'unknown'},{...input,petID:'../other'},{...input,bindingRevision:-1},
    {...input,records:[record,record]},{...input,records:[{...record,recordRevision:0}]},
    {...input,path:'/private'},{...input,records:Array(41).fill(record)},
    {role:'longmei',expectedRevision:0,records:[record]}]) assert.equal(isLiveSharingInput(value),false);
});
test('live sharing reply is bounded, role scoped, revisioned and carries no foreign grants', () => {
  const value = {ok:true,snapshot:{role:'longmei',petID:'pet-synthetic',bindingRevision:1,revision:0,
    records:[{...record,enabled:false,label:'当前身份',preview:'名称：合成角色'}]}};
  assert.equal(isLiveSharingResult(value),true);
  assert.equal(isLiveSharingResult({ok:false,error:'conflict'}),true);
  assert.equal(isLiveSharingResult({...value,snapshot:{...value.snapshot,records:[{...value.snapshot.records[0],petID:'pet-other'}]}}),false);
  assert.equal(isLiveSharingResult({...value,snapshot:{...value.snapshot,records:[...value.snapshot.records,...value.snapshot.records]}}),false);
  assert.equal(isLiveSharingResult({ok:false,error:'raw-secret'}),false);
});
