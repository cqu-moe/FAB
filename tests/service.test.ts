import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { QQClient, qqPrivateKey, verifyCallback, answerChallenge } from '../src/server/qq.js';
import { Engine } from '../src/server/engine.js';
import { createApp } from '../src/server/app.js';
import { defaultSettings, type Settings } from '../src/shared.js';

const secret='naOC0ocQE3shWLAfffVLB1rhYPG7'; // Public Tencent documentation fixture, not a credential.
const password='a-test-only-password-for-fab';
const origin='https://fab.test';
function fixture(path=':memory:') {
  const store=new Store(path), engine=new Engine(store,new QQClient('11111111',secret));
  const app=createApp(store,engine,{adminPassword:password,origin,appId:'11111111',appSecret:secret,retentionDays:30});
  let cookie='';
  const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>app.request(origin+path,{
    method,headers:{origin,'content-type':'application/json',cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const login=async()=>{
    const response=await request('/api/login','POST',{password}); assert.equal(response.status,200);
    cookie=response.headers.get('set-cookie')!.split(';')[0]; return response;
  };
  const group=async(id='GROUP_A',patch:Partial<Settings>={})=>{
    assert.equal((await request('/api/groups','POST',{id,name:`测试群 ${id}`})).status,201);
    assert.equal((await request(`/api/groups/${id}`,'PUT',{name:`测试群 ${id}`,revision:0,settings:{...defaultSettings(),...patch}})).status,200);
  };
  const event=(type:string,data:unknown,overrides:Record<string,string>={})=>{
    const raw=JSON.stringify({op:0,t:type,d:data}), timestamp=String(Math.floor(Date.now()/1000));
    return app.request(origin+'/qq/events',{method:'POST',headers:{'content-type':'application/json','x-bot-appid':'11111111','x-signature-timestamp':timestamp,'x-signature-ed25519':sign(null,Buffer.from(timestamp+raw),qqPrivateKey(secret)).toString('hex'),...overrides},body:raw});
  };
  return {store,engine,app,request,login,group,event};
}
const application=(member='MEMBER_A',request='REQUEST_A',name='示例同学',student='00123')=>({group_openid:'GROUP_A',member_openid:member,join_request_id:request,username:'申请人',verify_info:{method:'admin_review_qa',review_qa_list:[{question:'姓名',answer:name},{question:'学号',answer:student}]}});
const message=(id='MESSAGE_A',content='外链 https://spam.example/path',extra={})=>({group_openid:'GROUP_A',id,timestamp:new Date().toISOString(),author:{member_openid:'MEMBER_A',username:'成员',member_role:'member',bot:false},content,...extra});

function fakeQQ(t: TestContext, fail?:string, requests:unknown[]=[]) {
  const calls:{path:string;method:string;body:Record<string,unknown>|null}[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input)); assert.equal(url.origin,'https://api.bot.qq.com');
    const body=init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({path:url.pathname+url.search,method:init?.method??'GET',body});
    if(url.pathname==='/app/getAppAccessToken') return Response.json({access_token:'fake-provider-token',expires_in:7200});
    assert.equal(new Headers(init?.headers).get('authorization'),'QQBot fake-provider-token');
    if(fail && url.pathname.includes(fail)) return Response.json({err_code:11253,message:'upstream-sensitive-content'}, {status:200});
    if(url.pathname.endsWith('/join_request_list')) return Response.json({list:requests,next_cursor:''});
    if(url.pathname==='/v2/groups/join_approval_strategy' && init?.method==='POST') return Response.json({strategy_id:'STRATEGY_A'});
    return Response.json({});
  });
  return calls;
}

test('Tencent published Ed25519 vectors match; modified bodies and stale timestamps fail',t=>{
  t.mock.method(Date,'now',()=>1725442341000);
  // The published challenge is an independent timestamp+raw-bytes signature vector.
  const body='Arq0D5A61EgUu4OxUvOp', signingSecret='DG5g3B4j9X2KOErG';
  const signature='87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706';
  assert.equal(verifyCallback(signingSecret,'1725442341',signature,body),true);
  assert.equal(verifyCallback(signingSecret,'1725442341',signature,body+' '),false);
  assert.equal(verifyCallback(signingSecret,'1725440000',signature,body),false);
  const publicKey=createPublicKey(qqPrivateKey(secret)).export({format:'der',type:'spki'}).subarray(-32);
  assert.deepEqual([...publicKey],[215,195,98,254,120,174,248,31,242,50,135,180,147,98,139,93,176,42,60,79,227,11,33,94,77,25,96,155,93,118,103,58]);
  assert.equal(answerChallenge('DG5g3B4j9X2KOErG','Arq0D5A61EgUu4OxUvOp','1725442341').signature,'87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706');
});

test('admin session is required, cookies are protected, cross-origin writes fail, logout revokes session',async()=>{
  const f=fixture();
  try {
    assert.equal((await f.request('/api/groups')).status,401);
    const login=await f.login();
    assert.match(login.headers.get('set-cookie')!,/HttpOnly/); assert.match(login.headers.get('set-cookie')!,/Secure/); assert.match(login.headers.get('set-cookie')!,/SameSite=Strict/);
    const csp = login.headers.get('content-security-policy')!;
    // Distributed theme 1.1.0 bootstrap bytes: allow this script without opening inline execution.
    assert.ok(csp.includes("script-src 'self' 'sha256-pGI4JF4weer5IV5s0GKD85T+pt/KZtsoq6wwZ50vLlQ='"));
    assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"));
    assert.equal((await f.request('/api/groups','POST',{id:'GROUP_A',name:'测试'},{origin:'https://evil.test'})).status,403);
    assert.equal((await f.request('/api/groups')).headers.get('cache-control'),'no-store');
    await f.request('/api/logout','POST',{});
    assert.equal((await f.request('/api/groups')).status,401);
  } finally {f.store.close();}
});

test('unsigned callbacks cannot write; documented unsigned challenge is narrowly scoped',async()=>{
  const f=fixture();
  try {
    assert.equal((await f.event('GROUP_JOIN_REQUEST',application(),{'x-signature-ed25519':'00'.repeat(64)})).status,401);
    assert.equal(f.store.groups().length,0);
    const response=await f.app.request(origin+'/qq/events',{method:'POST',headers:{'x-bot-appid':'11111111','content-type':'application/json'},body:JSON.stringify({op:13,d:{plain_token:'opaque_token',event_ts:String(Math.floor(Date.now()/1000))}})});
    assert.equal(response.status,200); assert.equal((await response.json()).plain_token,'opaque_token');
    assert.equal((await f.app.request(origin+'/qq/events',{method:'POST',headers:{'x-bot-appid':'11111111'},body:JSON.stringify({op:13,d:{plain_token:JSON.stringify({op:0}),event_ts:String(Math.floor(Date.now()/1000))}})})).status,400);
  } finally {f.store.close();}
});

test('groups isolate settings, roster, records, and revision conflicts',async()=>{
  const f=fixture();
  try {
    await f.login(); await f.group(); await f.group('GROUP_B');
    await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'示例同学',studentId:'00123'}]});
    const a=await (await f.request('/api/groups/GROUP_A')).json(), b=await (await f.request('/api/groups/GROUP_B')).json();
    assert.equal(a.roster.length,1); assert.equal(b.roster.length,0);
    assert.equal((await f.request(`/api/groups/GROUP_B/roster/${a.roster[0].id}`,'DELETE')).status,404);
    assert.equal((await f.request('/api/groups/GROUP_A','PUT',{name:'旧标签页',revision:0,settings:defaultSettings()})).status,409);
    assert.equal((await f.request('/api/groups/GROUP_B','PUT',{name:'B',revision:b.group.revision,settings:{...b.group.settings,blockedPhrases:['   ']}})).status,400);
  } finally {f.store.close();}
});

test('CSV preview does not write, BOM/quotes/leading zeros survive, duplicate import is atomic',async()=>{
  const f=fixture();
  try {
    await f.login(); await f.group();
    const csv='\ufeff姓名,学号,QQ号,手机号\r\n"示例,甲",00123,100001,13800000000\r\n示例乙,00124,,\r\n';
    const preview=await f.request('/api/groups/GROUP_A/roster/import','POST',{csv,commit:false});
    assert.equal(preview.status,200); assert.equal(f.store.roster('GROUP_A').length,0);
    const parsed=await preview.json(); assert.equal(parsed.people[0].studentId,'00123'); assert.equal(parsed.people[0].name,'示例,甲');
    assert.equal((await f.request('/api/groups/GROUP_A/roster/import','POST',{csv,commit:true})).status,200);
    assert.equal((await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'新增',studentId:'00125'},{name:'重复',studentId:'00123'}]})).status,409);
    assert.equal(f.store.roster('GROUP_A').length,2);
    assert.equal((await f.request('/api/groups/GROUP_A/roster/import','POST',{csv:'姓名,学号,QQ号,手机号\n"broken,1,,',commit:true})).status,400);
  } finally {f.store.close();}
});

test('signed matching admission persists before ACK, executes once, and prevents another account claiming the identity',async t=>{
  const f=fixture(), calls=fakeQQ(t);
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto'});
    await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'示例同学',studentId:'00123',qq:'100001'}]});
    const event=application();
    assert.deepEqual(await (await f.event('GROUP_JOIN_REQUEST',event)).json(),{op:12});
    assert.equal(f.store.records('GROUP_A')[0].status,'queued'); assert.equal(calls.length,0);
    await f.event('GROUP_JOIN_REQUEST',event); await f.engine.drain();
    assert.equal(f.store.records('GROUP_A').length,1); assert.equal(f.store.records('GROUP_A')[0].status,'succeeded');
    assert.equal(f.store.roster('GROUP_A')[0].memberOpenid,'MEMBER_A');
    assert.deepEqual(calls.filter(c=>c.path.includes('approval_join_request')),[{path:'/v2/groups/GROUP_A/approval_join_request/MEMBER_A',method:'POST',body:{op:'approve',join_request_id:'REQUEST_A'}}]);
    await f.event('GROUP_JOIN_REQUEST',application('MEMBER_B','REQUEST_B'));
    assert.equal(f.store.records('GROUP_A')[0].status,'review');
    await f.event('GROUP_JOIN_REQUEST',application('MEMBER_C','REQUEST_C','其他姓名','00123'));
    assert.equal(f.store.records('GROUP_A')[0].status,'review');
  } finally {f.store.close();}
});

test('callback and pulled copies of one admission stay one record and execute once despite different QQ request IDs',async t=>{
  for(const first of ['callback','pull'] as const) await t.test(first,async t=>{
    const f=fixture();
    const event={...application(),apply_at:'2026-10-28T13:46:11+08:00',apply_source:'self_apply',verify_info:{method:'verify_message',verify_message:'姓名：示例同学\n学号：00123'}};
    const pulled={...event,join_request_id:'PULLED_REQUEST',apply_at:'2026-10-28T05:46:11Z',verify_info:{...event.verify_info,review_qa_list:[]}};
    const calls=fakeQQ(t,undefined,[pulled]);
    try {
      await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto'});
      await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'示例同学',studentId:'00123'}]});
      if(first==='callback') await f.event('GROUP_JOIN_REQUEST',event);
      const response=await f.request('/api/groups/GROUP_A/requests/pull','POST',{});
      assert.equal(response.status,200);
      if(first==='pull') await f.event('GROUP_JOIN_REQUEST',event);
      let detail=await (await f.request('/api/groups/GROUP_A')).json();
      assert.equal(detail.records.length,1,'one application must be shown once across callback and pull');
      assert.equal((await response.json()).count,first==='pull'?1:0);
      await f.engine.drain();
      await f.event('GROUP_JOIN_REQUEST',event);
      assert.equal((await (await f.request('/api/groups/GROUP_A/requests/pull','POST',{})).json()).count,0);
      await f.engine.drain();
      detail=await (await f.request('/api/groups/GROUP_A')).json();
      assert.equal(detail.records.length,1); assert.equal(detail.records[0].status,'succeeded');
      const approvals=calls.filter(c=>c.path.includes('/approval_join_request/'));
      assert.equal(approvals.length,1);
      assert.equal(approvals[0].body!.join_request_id,first==='callback'?'REQUEST_A':'PULLED_REQUEST');
      await f.event('GROUP_JOIN_REQUEST',{...event,join_request_id:'NEW_APPLICATION',apply_at:'2026-10-28T13:46:12+08:00'});
      assert.equal(f.store.records('GROUP_A').length,2,'a later application from the same member remains separate');
    } finally { f.store.close(); }
  });
});

test('admission dedup keeps distinct groups, members and application details separate',async t=>{
  const original={...application(),apply_at:'2026-10-28T13:46:11+08:00',apply_source:'invited',invited_by:'INVITER_A'};
  const cases:[string,object][]=[
    ['group',{group_openid:'GROUP_B'}],
    ['member',{member_openid:'MEMBER_B'}],
    ['inviter',{invited_by:'INVITER_B'}],
    ['answer',{verify_info:{method:'admin_review_qa',review_qa_list:[{question:'姓名',answer:'另一同学'},{question:'学号',answer:'00123'}]}}],
    ['risk',{risk_tips:'需核对安全风险'}],
  ];
  for(const [name,change] of cases) await t.test(name,async()=>{
    const f=fixture();
    try {
      await f.login(); await f.group(); await f.group('GROUP_B');
      await f.event('GROUP_JOIN_REQUEST',original);
      await f.event('GROUP_JOIN_REQUEST',{...original,...change,join_request_id:'ANOTHER_REQUEST'});
      const all=[...f.store.records('GROUP_A'),...f.store.records('GROUP_B')];
      assert.equal(all.length,2);
      assert.ok(all.every(record=>record.status==='review'));
    } finally { f.store.close(); }
  });
  for(const apply_at of [undefined,'invalid']) await t.test(`missing stable time: ${apply_at}`,async()=>{
    const f=fixture();
    try {
      await f.login(); await f.group();
      await f.event('GROUP_JOIN_REQUEST',{...original,apply_at});
      await f.event('GROUP_JOIN_REQUEST',{...original,apply_at,join_request_id:'ANOTHER_REQUEST'});
      assert.equal(f.store.records('GROUP_A').length,2);
    } finally { f.store.close(); }
  });
});

test('a pulled duplicate never resets or retries an approval whose result is unknown',async t=>{
  const f=fixture();
  const event={...application(),apply_at:'2026-10-28T13:46:11+08:00'};
  const calls=fakeQQ(t,undefined,[{...event,join_request_id:'PULLED_REQUEST'}]);
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',whitelistMembers:['MEMBER_A']});
    await f.event('GROUP_JOIN_REQUEST',event);
    f.store.db.exec("UPDATE records SET status='processing'"); f.store.recover();
    const before=f.store.records('GROUP_A')[0];
    assert.equal((await (await f.request('/api/groups/GROUP_A/requests/pull','POST',{})).json()).count,0);
    await f.engine.drain();
    assert.deepEqual(f.store.records('GROUP_A'),[before]);
    assert.equal(calls.filter(c=>c.path.includes('/approval_join_request/')).length,0);
  } finally { f.store.close(); }
});

test('admission dedup accepts epoch time and tolerates malformed historical payloads',async()=>{
  const f=fixture(), event={...application(),apply_at:'1970-01-01T00:00:00Z'};
  try {
    await f.login(); await f.group();
    await f.event('GROUP_JOIN_REQUEST',event);
    assert.equal(f.store.records('GROUP_A')[0].occurredAt,0);
    await f.event('GROUP_JOIN_REQUEST',{...event,join_request_id:'EPOCH_COPY'});
    assert.equal(f.store.records('GROUP_A').length,1);
    f.store.db.prepare('UPDATE records SET payload=?').run('invalid JSON');
    assert.equal((await f.event('GROUP_JOIN_REQUEST',{...event,join_request_id:'NEW_REQUEST'})).status,200);
    assert.equal(f.store.records('GROUP_A').length,2);
  } finally { f.store.close(); }
});

test('changed risk information on the same admission stops queued automatic approval',async t=>{
  for(const firstRisk of ['', '需核对安全风险']) await t.test(firstRisk || 'initially clear',async t=>{
    const f=fixture(), event={...application(),apply_at:'2026-10-28T13:46:11+08:00',risk_tips:firstRisk};
    const calls=fakeQQ(t,undefined,[{...event,join_request_id:'PULLED_REQUEST',risk_tips:firstRisk ? '' : '需核对安全风险'}]);
    try {
      await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',whitelistMembers:['MEMBER_A']});
      await f.event('GROUP_JOIN_REQUEST',event);
      assert.equal((await (await f.request('/api/groups/GROUP_A/requests/pull','POST',{})).json()).count,1);
      await f.engine.drain();
      const records=f.store.records('GROUP_A');
      assert.equal(records.length,2,'conflicting risk reports remain available for review');
      assert.ok(records.every(record=>record.status==='review'));
      assert.equal(calls.filter(c=>c.path.includes('/approval_join_request/')).length,0);
    } finally { f.store.close(); }
  });
});

test('risky, missing and ambiguous answers stay manual; normalized names and student IDs match deterministically',async()=>{
  const f=fixture();
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',unmatched:'decline'});
    await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'示例同学',studentId:'００１２３'}]});
    assert.equal(f.store.roster('GROUP_A')[0].studentId,'00123');
    for(const [id,event] of [
      ['RISK',{...application('M1','RISK'),risk_tips:'安全提示'}],
      ['MISSING',{...application('M2','MISSING'),verify_info:{method:'verify_message',verify_message:'我是示例同学00123'}}],
      ['AMBIG',{...application('M3','AMBIG'),verify_info:{method:'admin_review_qa',review_qa_list:[{question:'姓名',answer:'示例同学'},{question:'姓名',answer:'示例同学'},{question:'学号',answer:'00123'}]}}],
    ] as const) { await f.event('GROUP_JOIN_REQUEST',event); assert.equal(f.store.records('GROUP_A')[0].status,'review',id); }
    const preview=await (await f.request('/api/groups/GROUP_A/preview','POST',{kind:'join',text:'姓名：示例同学\n学号：００１２３'})).json();
    assert.equal(preview.decision,'approve');
  } finally {f.store.close();}
});

test('rule changes pause previously queued automatic approvals; recovery never blindly repeats in-flight actions',async()=>{
  const f=fixture();
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',whitelistMembers:['MEMBER_A']});
    await f.event('GROUP_JOIN_REQUEST',application());
    const g=f.store.group('GROUP_A')!;
    await f.request('/api/groups/GROUP_A','PUT',{name:g.name,revision:g.revision,settings:{...g.settings,enabled:false}});
    await f.engine.drain(); assert.equal(f.store.records('GROUP_A')[0].status,'review');
    f.store.db.exec("UPDATE records SET status='processing'"); f.store.recover();
    assert.equal(f.store.records('GROUP_A')[0].status,'failed'); assert.match(f.store.records('GROUP_A')[0].error!,/核对/);
  } finally {f.store.close();}
});

test('advertising detection handles nested cards, domain boundaries, role exemptions, and observation mode',async t=>{
  const f=fixture(), calls=fakeQQ(t);
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,moderationEnabled:true,blockedDomains:['spam.example']});
    for(const [id,url] of [['SAFE1','https://spam.example.safe.example'],['SAFE2','https://spam.example@safe.example']]) await f.event('GROUP_MESSAGE_CREATE',message(id,url));
    await f.event('GROUP_MESSAGE_CREATE',message('ADMIN','https://spam.example',{author:{member_openid:'OWNER',member_role:'admin'}}));
    assert.equal(f.store.records('GROUP_A').length,0);
    const card=message('CARD','',{msg_elements:[{ark_data:{fields:{title:'看这里',jump_url:'https://a.spam.example/path'}}}]});
    await f.event('GROUP_MESSAGE_CREATE',card); await f.event('GROUP_AT_MESSAGE_CREATE',card);
    assert.equal(f.store.records('GROUP_A').length,1); assert.equal(f.store.records('GROUP_A')[0].status,'observed');
    assert.equal(f.store.group('GROUP_A')!.reviewCount,1);
    await f.engine.drain(); assert.equal(calls.length,0);
  } finally {f.store.close();}
});

test('recall precedes mute, API errors never appear successful, and remote response content is redacted',async t=>{
  const f=fixture(), calls=fakeQQ(t,'restrict_chat_setting');
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,moderationEnabled:true,moderationMode:'recall_mute',blockedPhrases:['禁止广告']});
    await f.event('GROUP_MESSAGE_CREATE',message('AD','禁止广告')); await f.engine.drain();
    const record=f.store.records('GROUP_A')[0];
    assert.equal(record.status,'failed'); assert.equal(record.outcome,'QQ 已接受撤回消息');
    assert.match(record.error!,/11253/); assert.doesNotMatch(record.error!,/upstream-sensitive/);
    assert.equal(calls[1].method,'DELETE'); assert.equal(calls[1].path,'/v2/groups/GROUP_A/messages/AD');
    assert.equal(calls[2].path,'/v2/groups/GROUP_A/restrict_chat_setting');
  } finally {f.store.close();}
});

test('expired messages and media reviews never trigger automatic deletion',async t=>{
  const f=fixture(), calls=fakeQQ(t);
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,moderationEnabled:true,moderationMode:'recall',blockedPhrases:['广告']});
    await f.event('GROUP_MESSAGE_CREATE',message('OLD','广告',{timestamp:new Date(Date.now()-121000).toISOString()}));
    await f.event('GROUP_MESSAGE_CREATE',message('IMAGE','',{attachments:[{url:'http://127.0.0.1/private'}]}));
    await f.engine.drain();
    assert.equal(f.store.records('GROUP_A').find(r=>r.content==='广告')!.status,'expired');
    assert.equal(f.store.records('GROUP_A')[0].status,'review'); assert.equal(calls.length,0);
    assert.doesNotMatch(f.store.records('GROUP_A')[0].content,/127.0.0.1/);
  } finally {f.store.close();}
});

test('manual actions cannot cross groups and already successful operations cannot be repeated',async t=>{
  const f=fixture(); fakeQQ(t);
  try {
    await f.login(); await f.group(); await f.group('GROUP_B');
    await f.event('GROUP_JOIN_REQUEST',application()); const id=f.store.records('GROUP_A')[0].id;
    assert.equal((await f.request(`/api/groups/GROUP_B/records/${id}/action`,'POST',{action:'approve'})).status,400);
    assert.equal((await f.request(`/api/groups/GROUP_A/records/${id}/action`,'POST',{action:'approve'})).status,200);
    await f.engine.drain(); assert.equal(f.store.records('GROUP_A')[0].status,'succeeded');
    assert.equal((await f.request(`/api/groups/GROUP_A/records/${id}/action`,'POST',{action:'approve'})).status,400);
  } finally {f.store.close();}
});

test('QQ whitelist is created disabled, populated then enabled; pausing deletes the official strategy',async t=>{
  const f=fixture(), calls=fakeQQ(t);
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',whitelistQQ:['100001','100002']});
    const strategyCalls=calls.filter(c=>c.path.includes('join_approval_strategy'));
    assert.equal(strategyCalls[0].body!.is_enable,'off'); assert.deepEqual(strategyCalls[1].body,{op:'add',whitelist_users:['100001','100002']});
    assert.equal(strategyCalls[2].body!.is_enable,'on'); assert.deepEqual(f.store.group('GROUP_A')!.whitelistSynced,['100001','100002']);
    const group=f.store.group('GROUP_A')!;
    await f.request('/api/groups/GROUP_A','PUT',{name:group.name,revision:group.revision,settings:{...group.settings,enabled:false}});
    assert.equal(calls.at(-2)!.body!.is_enable,'off'); assert.equal(calls.at(-1)!.method,'DELETE'); assert.equal(f.store.group('GROUP_A')!.strategyId,null);
  } finally {f.store.close();}
});

test('failed whitelist sync is visible and never marks its membership as synchronized',async t=>{
  const f=fixture(); fakeQQ(t,'whitelist_users');
  try {
    await f.login(); await f.group('GROUP_A',{enabled:true,joinMode:'auto',whitelistQQ:['100001']});
    const group=f.store.group('GROUP_A')!;
    assert.deepEqual(group.whitelistSynced,[]); assert.match(group.whitelistError!,/未完成/);
  } finally {f.store.close();}
});

test('records and group settings persist through a database reopen',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'fab-test-')), path=join(folder,'fab.sqlite');
  let f=fixture(path);
  try {
    await f.login(); await f.group(); await f.event('GROUP_JOIN_REQUEST',application());
    f.store.close(); f=fixture(path);
    assert.equal(f.store.group('GROUP_A')!.name,'测试群 GROUP_A'); assert.equal(f.store.records('GROUP_A').length,1);
    assert.equal(f.store.records('GROUP_A')[0].status,'review');
  } finally {f.store.close(); rmSync(folder,{recursive:true,force:true});}
});

test('a database cannot switch QQ apps, and rotating the admin password invalidates existing sessions',async()=>{
  const f=fixture();
  try {
    await f.login();
    assert.throws(()=>createApp(f.store,new Engine(f.store,new QQClient('22222222',secret)),{
      adminPassword:password,origin,appId:'22222222',appSecret:secret,retentionDays:30,
    }),/另一个 QQ AppID/);
    assert.equal((await f.request('/api/groups')).status,200);
    createApp(f.store,f.engine,{adminPassword:password+'-rotated',origin,appId:'11111111',appSecret:secret,retentionDays:30});
    assert.equal((await f.request('/api/groups')).status,401);
  } finally {f.store.close();}
});

test('normalized student IDs remain unique and equivalent question names are rejected',async()=>{
  const f=fixture();
  try {
    await f.login(); await f.group();
    assert.equal((await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'同学甲',studentId:'Ａ  １'}]})).status,201);
    assert.equal((await f.request('/api/groups/GROUP_A/roster','POST',{people:[{name:'同学乙',studentId:'A 1'}]})).status,409);
    const g=f.store.group('GROUP_A')!;
    assert.equal((await f.request('/api/groups/GROUP_A','PUT',{name:g.name,revision:g.revision,settings:{...g.settings,nameQuestion:'Ｎａｍｅ',studentQuestion:'Name'}})).status,400);
  } finally {f.store.close();}
});
