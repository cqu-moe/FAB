import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshWorkspace } from '../src/web/App.js';
import { defaultSettings, type Group } from '../src/shared.js';

const group: Group = { id:'GROUP_A', name:'测试群', settings:defaultSettings(), revision:0, lastEventAt:null, strategyId:null, whitelistSynced:[], whitelistError:null, rosterCount:0, reviewCount:0 };

test('returning to a group preserves unsaved settings, CSV and person drafts',()=>{
  const previous=refreshWorkspace(undefined,group,false);
  previous.csv='尚未导入的名单';
  previous.person={id:null,values:{name:'测试',studentId:'001',qq:'',phone:''}};
  previous.draft.settings={...previous.draft.settings,nameQuestion:'真实姓名'};
  const next=refreshWorkspace(previous,{...group,revision:1},true);
  assert.equal(next.draft.settings.nameQuestion,'真实姓名');
  assert.equal(next.csv,previous.csv);
  assert.deepEqual(next.person,previous.person);
  assert.equal(next.conflict,false);
  assert.equal(next.draft.revision,1);
});

test('server changes conflict only with an edited draft, and explicit discard resets it',()=>{
  const clean=refreshWorkspace(undefined,group,false);
  clean.csv='保留尚未导入的内容';
  const changed={...group,name:'另一页面改名',revision:1};
  const refreshed=refreshWorkspace(clean,changed,true);
  assert.equal(refreshed.draft.name,changed.name);
  assert.equal(refreshed.csv,clean.csv);
  assert.equal(refreshed.conflict,false);
  clean.draft.name='本页改名';
  const conflict=refreshWorkspace(clean,changed,true);
  assert.equal(conflict.conflict,true);
  assert.equal(conflict.draft.name,'本页改名');
  const discarded=refreshWorkspace(conflict,changed,false);
  assert.equal(discarded.conflict,false);
  assert.equal(discarded.draft.name,changed.name);
  assert.equal(discarded.csv,'');
});
