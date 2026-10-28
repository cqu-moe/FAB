import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import { groupInputSchema, groupUpdateSchema, opaqueId, personSchema, type SystemStatus } from '../shared.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { answerChallenge, verifyCallback, QQError } from './qq.js';
import { decideJoin, decideMessage, previewJoin } from './rules.js';
import { parseRosterCsv } from './csv.js';

export type AppConfig = { adminPassword:string; origin:string; appId:string; appSecret:string; retentionDays:number };
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=(message:string)=>new HTTPException(400,{message});
const numericId=(value:string)=>z.coerce.number().int().positive().safe().parse(value);

export function createApp(store:Store, engine:Engine, config:AppConfig) {
  const app=new Hono();
  const origin=new URL(config.origin).origin;
  const secure=origin.startsWith('https:');
  const cookieOptions={httpOnly:true,secure,sameSite:'Strict' as const,path:'/',maxAge:8*3600};
  const status=():SystemStatus=>({qqConfigured:engine.qq.configured,appId:config.appId,webhookPath:'/qq/events',retentionDays:config.retentionDays});
  store.db.exec('CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);');
  store.db.exec('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  const boundApp=store.db.prepare("SELECT value FROM metadata WHERE key='qq_app_id'").get();
  if(config.appId && boundApp && boundApp.value!==config.appId) throw new Error('此数据库属于另一个 QQ AppID；更换机器人请使用独立数据库');
  if(config.appId) store.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('qq_app_id',?)").run(config.appId);
  const passwordHash=digest(config.adminPassword);
  const previousPassword=store.db.prepare("SELECT value FROM metadata WHERE key='admin_password_hash'").get();
  if(previousPassword?.value!==passwordHash) store.db.prepare('DELETE FROM sessions').run();
  store.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('admin_password_hash',?)").run(passwordHash);
  let loginFailures:number[]=[];
  app.use('*',secureHeaders({contentSecurityPolicy:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],objectSrc:["'none'"],frameAncestors:["'none'"],baseUri:["'self'"],formAction:["'self'"]}}));
  app.use('*',bodyLimit({maxSize:2_000_000,onError:c=>c.json({error:'请求超过大小限制'},413)}));
  app.use('/api/*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    if(!['GET','HEAD'].includes(c.req.method)) {
      if(c.req.header('origin')!==origin) throw new HTTPException(403,{message:'请求来源不匹配'});
      if(c.req.method!=='DELETE' && !c.req.header('content-type')?.startsWith('application/json')) throw new HTTPException(415,{message:'请使用 JSON 请求'});
    }
    if(c.req.path==='/api/login') return next();
    const token=getCookie(c,'fab_session');
    if(!token || !/^[a-f0-9]{64}$/.test(token) || !store.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires_at>?').get(digest(token),Date.now())) throw new HTTPException(401,{message:'请先登录控制面板'});
    return next();
  });
  app.post('/api/login',async c=>{
    loginFailures=loginFailures.filter(t=>Date.now()-t<300000);
    if(loginFailures.length>=10) throw new HTTPException(429,{message:'登录尝试过多，请五分钟后再试'});
    const {password}=z.object({password:z.string().min(1).max(1024)}).parse(await c.req.json());
    const actual=Buffer.from(digest(password),'hex'), expected=Buffer.from(digest(config.adminPassword),'hex');
    if(!timingSafeEqual(actual,expected)) { loginFailures.push(Date.now()); throw new HTTPException(401,{message:'管理密码不正确'}); }
    const token=randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions(hash,expires_at) VALUES(?,?)').run(digest(token),Date.now()+8*3600000);
    setCookie(c,'fab_session',token,cookieOptions);
    return c.json({authenticated:true,status:status()});
  });
  app.get('/api/session',c=>c.json({authenticated:true,status:status()}));
  app.post('/api/logout',c=>{
    const token=getCookie(c,'fab_session');
    if(token) store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));
    deleteCookie(c,'fab_session',{path:'/',secure,sameSite:'Strict'});
    return c.json({ok:true});
  });
  app.get('/health',c=>c.json({ok:true}));
  app.get('/api/groups',c=>c.json({groups:store.groups(),status:status()}));
  app.post('/api/groups',async c=>{
    const input=groupInputSchema.parse(await c.req.json());
    store.addGroup(input.id,input.name);
    return c.json({group:store.group(input.id)},201);
  });
  app.use('/api/groups/:group/*',async(c,next)=>{
    const id=opaqueId.parse(c.req.param('group'));
    if(!store.group(id)) throw new HTTPException(404,{message:'群不存在'});
    return next();
  });
  app.get('/api/groups/:group',c=>{
    const group=store.group(opaqueId.parse(c.req.param('group')));
    if(!group) throw new HTTPException(404,{message:'群不存在'});
    return c.json({group,roster:store.roster(group.id),records:store.records(group.id)});
  });
  app.put('/api/groups/:group',async c=>{
    const id=opaqueId.parse(c.req.param('group'));
    const previous=store.group(id);
    if(!previous) throw new HTTPException(404,{message:'群不存在'});
    if(engine.isSyncing(id)) throw new HTTPException(409,{message:'白名单同步中，请稍后保存'});
    const input=groupUpdateSchema.parse(await c.req.json());
    if(previous.revision!==input.revision) throw new HTTPException(409,{message:'配置已被其他页面更新，请刷新后重新修改'});
    store.saveGroup(id,input.name,input.settings,input.revision);
    const needsSync=JSON.stringify(previous.settings.whitelistQQ)!==JSON.stringify(input.settings.whitelistQQ) || previous.settings.enabled!==input.settings.enabled || previous.settings.joinMode!==input.settings.joinMode;
    if(needsSync && (previous.strategyId || input.settings.whitelistQQ.length)) {
      try { await engine.syncWhitelist(id); } catch { /* Saved local settings and the explicit remote error are both returned. */ }
    }
    return c.json({group:store.group(id)});
  });
  const bump=(id:string)=>store.db.prepare('UPDATE groups SET revision=revision+1 WHERE id=?').run(id);
  app.post('/api/groups/:group/roster',async c=>{
    const {people}=z.object({people:z.array(personSchema).min(1).max(10000)}).parse(await c.req.json());
    const id=c.req.param('group');
    if(store.roster(id).length+people.length>10000) throw bad('每群首版最多维护 10000 人');
    store.addPeople(id,people); bump(id);
    return c.json({count:people.length},201);
  });
  app.post('/api/groups/:group/roster/import',async c=>{
    const {csv,commit}=z.object({csv:z.string().max(1_500_000),commit:z.boolean()}).parse(await c.req.json());
    let people;
    try { people=parseRosterCsv(csv); } catch(e) { throw bad(e instanceof Error?e.message:'CSV 格式不正确'); }
    const id=c.req.param('group'), roster=store.roster(id);
    if(roster.length+people.length>10000) throw bad('每群首版最多维护 10000 人');
    const ids=new Set(roster.map(p=>p.studentId)), qqs=new Set(roster.filter(p=>p.qq).map(p=>p.qq));
    if(people.some(p=>ids.has(p.studentId) || (p.qq && qqs.has(p.qq)))) throw new HTTPException(409,{message:'导入中有已存在的学号或 QQ 号，请编辑已有人员或先移除重复行'});
    if(commit) { store.addPeople(id,people); bump(id); }
    return c.json({people,count:people.length});
  });
  app.put('/api/groups/:group/roster/:person',async c=>{
    const id=c.req.param('group'), personId=numericId(c.req.param('person'));
    const p=personSchema.parse(await c.req.json());
    const old=store.roster(id).find(p=>p.id===personId);
    if(!old) throw new HTTPException(404,{message:'名单人员不存在'});
    const binding=old.name===p.name && old.studentId===p.studentId && old.qq===p.qq ? old.memberOpenid : null;
    store.db.prepare('UPDATE roster SET name=?,student_id=?,qq=?,phone=?,member_openid=? WHERE id=? AND group_id=?').run(p.name,p.studentId,p.qq,p.phone,binding,personId,id);
    bump(id); store.audit(id,`更新名单记录 ${personId}`);
    return c.json({ok:true});
  });
  app.delete('/api/groups/:group/roster/:person',c=>{
    const id=c.req.param('group'), personId=numericId(c.req.param('person'));
    const result=store.db.prepare('DELETE FROM roster WHERE id=? AND group_id=?').run(personId,id);
    if(!result.changes) throw new HTTPException(404,{message:'名单人员不存在'});
    bump(id); store.audit(id,`删除名单记录 ${personId}`);
    return c.json({ok:true});
  });
  app.post('/api/groups/:group/whitelist/sync',async c=>{
    try { await engine.syncWhitelist(c.req.param('group')); } catch(e) { throw bad(e instanceof Error?e.message:'同步失败'); }
    return c.json({ok:true});
  });
  app.post('/api/groups/:group/requests/pull',async c=>c.json({count:await engine.pullRequests(c.req.param('group'))}));
  app.get('/api/groups/:group/records',c=>c.json({records:store.records(c.req.param('group'),c.req.query('before')?numericId(c.req.query('before')!):undefined)}));
  app.post('/api/groups/:group/records/:record/action',async c=>{
    const {action}=z.object({action:z.enum(['approve','decline','ignore','recall','recall_mute'])}).parse(await c.req.json());
    try { engine.queueAction(c.req.param('group'),numericId(c.req.param('record')),action); } catch(e) { throw bad(e instanceof Error?e.message:'操作失败'); }
    return c.json({ok:true});
  });
  app.post('/api/groups/:group/preview',async c=>{
    const {kind,text}=z.object({kind:z.enum(['join','message']),text:z.string().max(64000)}).parse(await c.req.json());
    const group=store.group(c.req.param('group'))!;
    const result=kind==='join' ? decideJoin(previewJoin(text,group.id),group.settings,store.roster(group.id)) : decideMessage({id:'preview',group_openid:group.id,memberOpenid:'preview',username:'预览',role:'member',bot:false,text,media:false,timestamp:Date.now()},group.settings);
    return c.json(result);
  });
  app.get('/api/groups/:group/audit',c=>c.json({entries:store.db.prepare('SELECT action,created_at AS createdAt FROM audit WHERE group_id=? ORDER BY id DESC LIMIT 100').all(c.req.param('group'))}));

  app.post('/qq/events',bodyLimit({maxSize:512000,onError:c=>c.json({error:'回调体过大'},413)}),async c=>{
    if(!engine.qq.configured) throw new HTTPException(503,{message:'尚未配置 QQ 接入'});
    const raw=await c.req.text();
    const payload=z.object({op:z.number().int(),t:z.string().optional(),d:z.unknown()}).parse(JSON.parse(raw));
    const appId=c.req.header('x-bot-appid');
    if(appId && appId!==config.appId) throw new HTTPException(401,{message:'机器人标识不匹配'});
    if(payload.op===13) {
      // Tencent's documented challenge has no signature headers; restrict it to opaque tokens, never JSON signing.
      if(appId!==config.appId) throw new HTTPException(401,{message:'机器人标识不匹配'});
      const d=z.object({plain_token:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),event_ts:z.string().regex(/^\d{10}$/)}).parse(payload.d);
      if(Math.abs(Date.now()/1000-Number(d.event_ts))>300) throw bad('验证请求已过期');
      return c.json(answerChallenge(config.appSecret,d.plain_token,d.event_ts));
    }
    if(!verifyCallback(config.appSecret,c.req.header('x-signature-timestamp')??'',c.req.header('x-signature-ed25519')??'',raw)) throw new HTTPException(401,{message:'回调签名无效或已过期'});
    if(payload.op===0 && payload.t) engine.ingest(payload.t,payload.d);
    return c.json({op:12});
  });
  app.onError((error,c)=>{
    if(error instanceof HTTPException) return c.json({error:error.message},error.status);
    if(error instanceof ZodError) return c.json({error:error.issues[0]?.message??'输入格式不正确'},400);
    if(error instanceof SyntaxError) return c.json({error:'JSON 格式不正确'},400);
    if(error instanceof QQError) return c.json({error:error.message},502);
    if(error.message.includes('UNIQUE constraint')) return c.json({error:'群已存在，或本群名单的学号、QQ 号、身份关联存在重复'},409);
    console.error(JSON.stringify({event:'request_failed',type:error.name}));
    return c.json({error:'操作失败，请刷新后重试；已执行的 QQ 操作请先核对结果'},500);
  });
  return app;
}
