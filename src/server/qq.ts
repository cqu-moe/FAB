import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';

export function qqPrivateKey(secret: string) {
  if (!secret) throw new Error('未配置 QQ AppSecret');
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({ key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed.subarray(0,32)]), format:'der', type:'pkcs8' });
}
export function verifyCallback(secret: string, timestamp: string, signature: string, raw: string) {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  if (Math.abs(Date.now()/1000-Number(timestamp))>300) return false;
  try { return verify(null,Buffer.from(timestamp+raw),createPublicKey(qqPrivateKey(secret)),Buffer.from(signature,'hex')); } catch { return false; }
}
export function answerChallenge(secret: string, token: string, timestamp: string) {
  return { plain_token:token, signature:sign(null,Buffer.from(timestamp+token),qqPrivateKey(secret)).toString('hex') };
}

export class QQError extends Error {
  constructor(message: string, readonly code: number | string, readonly traceId = '') { super(message); }
}

export class QQClient {
  private token = '';
  private expires = 0;
  private tokenFlight: Promise<string> | null = null;
  private gate: Promise<unknown> = Promise.resolve();
  private next = new Map<string,number>();
  constructor(readonly appId: string, private secret: string) {}
  get configured() { return Boolean(this.appId && this.secret); }
  private async decode(response: Response): Promise<Record<string,unknown>> {
    const body = await response.text();
    if (body.length>2_000_000) throw new QQError('QQ 响应超出大小限制','oversize');
    let data: Record<string,unknown> = {};
    try { data = body ? z.record(z.string(),z.unknown()).parse(JSON.parse(body)) : {}; }
    catch { throw new QQError(`QQ 返回了无法解析的响应（HTTP ${response.status}）`,'invalid_response'); }
    const code = Number(data.err_code ?? data.code ?? 0);
    if (!response.ok || code !== 0) {
      const trace = typeof data.trace_id === 'string' ? data.trace_id.slice(0,100) : '';
      // Never persist provider response text: it may echo credentials or user content.
      throw new QQError(`QQ 调用失败（HTTP ${response.status}，错误码 ${code || response.status}）${trace ? `，Trace ID ${trace}` : ''}`,code || response.status,trace);
    }
    return data;
  }
  private async accessToken(): Promise<string> {
    if (!this.configured) throw new QQError('尚未配置 QQ AppID 和 AppSecret','not_configured');
    if(this.token && this.expires>Date.now()+60000) return this.token;
    if(this.tokenFlight) return this.tokenFlight;
    this.tokenFlight = (async () => {
      const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({appId:this.appId,clientSecret:this.secret}), signal:AbortSignal.timeout(5000), redirect:'error',
      });
      const data = await this.decode(response);
      const parsed = z.object({access_token:z.string().min(1),expires_in:z.coerce.number().positive()}).parse(data);
      this.token=parsed.access_token; this.expires=Date.now()+parsed.expires_in*1000;
      return this.token;
    })().finally(()=>{this.tokenFlight=null;});
    return this.tokenFlight;
  }
  async call(path: string, method='GET', body?: unknown, deadline?: number) {
    if (!this.configured) throw new QQError('尚未配置 QQ AppID 和 AppSecret','not_configured');
    const category = method==='DELETE' && path.includes('/messages/') ? 'recall' : path.includes('approval_join_request') ? 'approve' : path.includes('restrict_chat') ? 'mute' : path.includes('join_approval_strategy') ? 'strategy' : 'read';
    const interval = category==='recall' ? 110 : category==='read' ? 2100 : 1100;
    const task = this.gate.catch(()=>{}).then(async () => {
      const delay=Math.max(0,(this.next.get(category)??0)-Date.now());
      if(deadline && Date.now()+delay+6000>=deadline) throw new QQError('已接近 QQ 消息撤回时限，请在 QQ 中核实','expired');
      if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
      this.next.set(category,Date.now()+interval);
      const token=await this.accessToken();
      if(deadline && Date.now()+1000>=deadline) throw new QQError('已超过 QQ 消息撤回时限','expired');
      const response=await fetch(`https://api.bot.qq.com${path}`, {
        method, headers:{Authorization:`QQBot ${token}`,'content-type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(6000), redirect:'error',
      });
      return this.decode(response);
    });
    this.gate=task;
    return task;
  }
}
