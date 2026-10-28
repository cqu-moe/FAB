import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { QQClient } from './qq.js';
import { Engine } from './engine.js';
import { createApp } from './app.js';

const adminPassword=process.env.ADMIN_PASSWORD??'';
if(adminPassword.length<16) throw new Error('请在 .env 中设置至少 16 字符的 ADMIN_PASSWORD');
const appId=process.env.QQ_APP_ID??'', appSecret=process.env.QQ_APP_SECRET??'';
if(Boolean(appId)!==Boolean(appSecret)) throw new Error('QQ_APP_ID 与 QQ_APP_SECRET 必须同时配置');
const origin=process.env.APP_ORIGIN??'http://127.0.0.1:3030';
const url=new URL(origin);
if(!['https:','http:'].includes(url.protocol) || url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw new Error('APP_ORIGIN 须为完整网站来源，例如 https://fab.example.com');
const database=resolve(process.env.DATABASE_PATH??'data/fab.sqlite');
mkdirSync(dirname(database),{recursive:true,mode:0o700});
const store=new Store(database);
const engine=new Engine(store,new QQClient(appId,appSecret));
const retentionDays=Number(process.env.RETENTION_DAYS??30);
if(!Number.isInteger(retentionDays) || retentionDays<1 || retentionDays>365) throw new Error('RETENTION_DAYS 须在 1–365 之间');
const app=createApp(store,engine,{adminPassword,origin,appId,appSecret,retentionDays});
app.use('/assets/*',serveStatic({root:'./dist'}));
app.get('/',serveStatic({path:'./dist/index.html'}));
store.recover(); store.cleanup(retentionDays);
// shortcut: one service process; move to a shared job queue before running multiple replicas.
const work=setInterval(()=>{void engine.drain().catch(()=>console.error('{"event":"worker_failed"}'));},500);
const clean=setInterval(()=>store.cleanup(retentionDays),3600000);
const port=Number(process.env.PORT??3030);
const server=serve({fetch:app.fetch,hostname:process.env.HOST??'127.0.0.1',port},()=>console.log(`FAB 已启动：${origin}；QQ ${engine.qq.configured?'已配置（权限待实测）':'尚未接入'}`));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
  clearInterval(work); clearInterval(clean); server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),8000).unref();
});
