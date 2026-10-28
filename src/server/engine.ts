import { createHash } from 'node:crypto';
import { z } from 'zod';
import { joinEventSchema, opaqueId, type Decision, type Group, type JoinEvent, type MessageData, type RecordStatus } from '../shared.js';
import { decideJoin, decideMessage, parseMessage } from './rules.js';
import { Store, type StoredRecord } from './store.js';
import { QQClient, QQError } from './qq.js';

const safeError=(e:unknown) => e instanceof QQError ? e.message : e instanceof Error && e.name==='TimeoutError' ? 'QQ 请求超时，结果可能已生效，请在 QQ 核实后再重试' : '执行结果未确认，请检查网络和权限，并在 QQ 核实后再重试';

export class Engine {
  private running = false;
  private syncing = new Set<string>();
  constructor(readonly store: Store, readonly qq: QQClient) {}
  ingest(type: string, input: unknown) {
    if (type==='GROUP_JOIN_REQUEST') return this.ingestJoin(joinEventSchema.parse(input));
    if (type==='GROUP_MESSAGE_CREATE' || type==='GROUP_AT_MESSAGE_CREATE') return this.ingestMessage(parseMessage(input));
    if (['GROUP_ADD_ROBOT','GROUP_DEL_ROBOT','GROUP_MSG_REJECT'].includes(type)) {
      const data=z.object({group_openid:opaqueId}).parse(input);
      this.store.discover(data.group_openid);
      if(type!=='GROUP_ADD_ROBOT') {
        const group=this.store.group(data.group_openid)!;
        this.store.saveGroup(group.id,group.name,{...group.settings,enabled:false},group.revision);
        this.store.db.prepare('UPDATE groups SET whitelist_error=? WHERE id=?').run('机器人权限或群状态发生变化，请在 QQ 平台核对自动审批策略',group.id);
      }
    }
  }
  private once(groupId: string, kind: string, externalId: string, fn: (group:Group)=>void) {
    const key=createHash('sha256').update(`${kind}:${groupId}:${externalId}`).digest('hex');
    this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM seen WHERE id=?').get(key)) return;
      this.store.discover(groupId);
      fn(this.store.group(groupId)!);
      this.store.db.prepare('INSERT INTO seen(id,created_at) VALUES(?,?)').run(key,Date.now());
    });
  }
  ingestJoin(event: JoinEvent) {
    this.once(event.group_openid,'join',event.join_request_id,group=>{
      const result=decideJoin(event,group.settings,this.store.roster(group.id));
      const automatic=group.settings.enabled && group.settings.joinMode==='auto';
      const status:RecordStatus=event.auto_approved ? 'succeeded' : automatic && ['approve','decline'].includes(result.decision) ? 'queued' : 'review';
      const content=event.verify_info?.method==='admin_review_qa' ? event.verify_info.review_qa_list?.map(p=>`${p.question}：${p.answer}`).join('\n') ?? '' : event.verify_info?.verify_message ?? '未提供验证信息';
      this.store.insertRecord({groupId:group.id,kind:'join',externalId:event.join_request_id,memberOpenid:event.member_openid,username:event.username,
        content,payload:JSON.stringify(event),reason:event.auto_approved ? 'QQ 官方白名单策略已自动通过，本地未重复审批' : !automatic ? `人工审核：${result.reason}` : result.reason,
        decision:event.auto_approved ? 'approve' : result.decision,status,occurredAt:Date.parse(event.apply_at??'') || Date.now(),automatic,revision:group.revision,personId:result.personId??null});
    });
  }
  private ingestMessage(message: MessageData) {
    this.once(message.group_openid,'message',message.id,group=>{
      if(!group.settings.enabled || !group.settings.moderationEnabled) return;
      const result=decideMessage(message,group.settings);
      if(result.decision==='ignore') return;
      const invalidTime=message.timestamp>Date.now()+30000;
      const status:RecordStatus=invalidTime || result.decision==='review' ? 'review' : group.settings.moderationMode==='observe' ? 'observed' : 'queued';
      this.store.insertRecord({groupId:group.id,kind:'message',externalId:message.id,memberOpenid:message.memberOpenid,username:message.username,
        content:message.text || '[图片或附件消息]',payload:JSON.stringify(message),reason:invalidTime ? '消息时间异常，需人工复核' : result.reason,
        decision:result.decision,status,occurredAt:message.timestamp,automatic:true,revision:group.revision,personId:null});
    });
  }
  async drain() {
    if(this.running) return;
    this.running=true;
    try {
      for(let i=0;i<30;i++) {
        const row=this.store.db.prepare("SELECT id FROM records WHERE status='queued' ORDER BY CASE kind WHEN 'message' THEN 0 ELSE 1 END,occurred_at LIMIT 1").get();
        if(!row) break;
        const record=this.store.record(Number(row.id))!;
        const changed=this.store.db.prepare("UPDATE records SET status='processing' WHERE id=? AND status='queued'").run(record.id);
        if(!changed.changes) continue;
        await this.execute(record);
      }
    } finally { this.running=false; }
  }
  private async execute(record:StoredRecord) {
    const group=this.store.group(record.groupId)!;
    if(record.automatic && (!group.settings.enabled || record.revision!==group.revision)) {
      this.store.finish(record.id,'review',null,'群规则或名单已变更，已停止旧规则的自动操作'); return;
    }
    try {
      if(record.kind==='join') {
        const event=joinEventSchema.parse(JSON.parse(record.payload));
        const person=this.store.roster(group.id).find(p=>p.id===record.personId);
        if(record.decision==='approve' && record.personId && (!person || (person.memberOpenid && person.memberOpenid!==record.memberOpenid))) {
          this.store.finish(record.id,'review',null,'人员绑定已变化，需人工核实'); return;
        }
        await this.qq.call(`/v2/groups/${group.id}/approval_join_request/${record.memberOpenid}`,'POST',{
          op:record.decision==='approve' ? 'approve' : 'decline',join_request_id:event.join_request_id,
          ...(record.decision==='decline' ? {reject_reason:'未通过本群入群核验，请核对姓名和学号后重新申请'} : {}),
        });
        const outcome=record.decision==='approve'?'QQ 已接受通过申请':'QQ 已接受拒绝申请';
        this.store.finish(record.id,'succeeded',outcome);
        if(record.decision==='approve' && person) {
          try {
            const match=decideJoin(event,this.store.group(group.id)!.settings,this.store.roster(group.id));
            if(match.personId!==person.id) throw new Error('名单已变化');
            const bound=this.store.db.prepare('UPDATE roster SET member_openid=? WHERE id=? AND group_id=? AND name=? AND student_id=? AND (member_openid IS NULL OR member_openid=?)').run(record.memberOpenid,person.id,group.id,person.name,person.studentId,record.memberOpenid);
            if(!bound.changes) throw new Error('名单已变化');
          } catch { this.store.finish(record.id,'succeeded',`${outcome}；名单关联未完成，请人工核实`); }
        }
      } else {
        const message=JSON.parse(record.payload) as MessageData;
        if(message.role!=='member' || message.bot) { this.store.finish(record.id,'failed',null,'QQ 仅允许处置普通成员的消息'); return; }
        if(!record.recalled) {
          if(Date.now()-record.occurredAt>=120000 || record.occurredAt>Date.now()+30000) { this.store.finish(record.id,'expired',null,'已超过两分钟撤回时限或消息时间异常'); return; }
          await this.qq.call(`/v2/groups/${group.id}/messages/${encodeURIComponent(message.id)}`,'DELETE',undefined,record.occurredAt+120000);
          this.store.db.prepare('UPDATE records SET recalled=1,outcome=? WHERE id=?').run('QQ 已接受撤回消息',record.id);
        }
        if(record.decision==='recall_mute') await this.qq.call(`/v2/groups/${group.id}/restrict_chat_setting`,'POST',{
          members:[{op:'add',member_openid:record.memberOpenid,mute_expire_at:new Date(Date.now()+group.settings.muteMinutes*60000).toISOString()}],
        });
        this.store.finish(record.id,'succeeded',record.decision==='recall_mute'?'QQ 已接受撤回与禁言':'QQ 已接受撤回消息');
      }
    } catch(e) {
      const current=this.store.record(record.id)!;
      this.store.finish(record.id,e instanceof QQError && e.code==='expired' ? 'expired' : 'failed',current.outcome,safeError(e));
    }
  }
  queueAction(groupId:string, id:number, decision:Decision) {
    const record=this.store.record(id,groupId);
    if(!record) throw new Error('记录不存在');
    if(!['review','failed','observed','expired'].includes(record.status)) throw new Error('此记录已处理或正在执行');
    const allowed=record.kind==='join' ? ['approve','decline','ignore'] : ['recall','recall_mute','ignore'];
    if(!allowed.includes(decision)) throw new Error('该操作不适用于此记录');
    this.store.db.prepare('UPDATE records SET decision=?,status=?,automatic=0,error=NULL WHERE id=?').run(decision,decision==='ignore'?'ignored':'queued',id);
    this.store.audit(groupId,`人工处理记录 ${id}：${decision}`);
  }
  async syncWhitelist(groupId:string) {
    if(this.syncing.has(groupId)) throw new Error('本群白名单正在同步，请稍后刷新');
    this.syncing.add(groupId);
    try {
      const group=this.store.group(groupId)!;
      // Recreate a disabled strategy to avoid stale members after a partial update.
      if(group.strategyId) {
        await this.qq.call(`/v2/groups/join_approval_strategy/${encodeURIComponent(group.strategyId)}`,'PATCH',{is_enable:'off'});
        await this.qq.call(`/v2/groups/join_approval_strategy/${encodeURIComponent(group.strategyId)}`,'DELETE');
        this.store.db.prepare("UPDATE groups SET strategy_id=NULL,whitelist_synced='[]' WHERE id=?").run(groupId);
      }
      if(group.settings.enabled && group.settings.joinMode==='auto' && group.settings.whitelistQQ.length) {
        const response=await this.qq.call('/v2/groups/join_approval_strategy','POST',{group_openids:[group.id],is_enable:'off',remark:'FAB 群入群白名单'});
        const strategyId=z.string().min(1).max(256).parse(response.strategy_id);
        this.store.db.prepare('UPDATE groups SET strategy_id=? WHERE id=?').run(strategyId,group.id);
        await this.qq.call(`/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}/whitelist_users`,'POST',{op:'add',whitelist_users:[...new Set(group.settings.whitelistQQ)]});
        if(this.store.group(groupId)!.revision!==group.revision) throw new Error('同步时群配置发生变化，请重新同步');
        await this.qq.call(`/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}`,'PATCH',{is_enable:'on'});
        this.store.db.prepare('UPDATE groups SET whitelist_synced=? WHERE id=?').run(JSON.stringify(group.settings.whitelistQQ),groupId);
      }
      this.store.db.prepare('UPDATE groups SET whitelist_error=NULL WHERE id=?').run(groupId);
      this.store.audit(groupId,'同步 QQ 官方白名单策略');
    } catch(e) {
      const error=`白名单同步未完成，旧的官方策略可能仍生效；请在开放平台核对。${safeError(e)}`;
      this.store.db.prepare('UPDATE groups SET whitelist_error=? WHERE id=?').run(error,groupId);
      throw new Error(error);
    } finally { this.syncing.delete(groupId); }
  }
  isSyncing(groupId:string) { return this.syncing.has(groupId); }
  async pullRequests(groupId:string) {
    let cursor='', count=0;
    const cursors=new Set<string>();
    for(let page=0;page<20;page++) {
      const data=await this.qq.call(`/v2/groups/${groupId}/join_request_list?limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
      const parsed=z.object({list:z.array(z.unknown()),next_cursor:z.string().default('')}).parse(data);
      for(const item of parsed.list) {
        const event=joinEventSchema.parse({...z.record(z.string(),z.unknown()).parse(item),group_openid:groupId});
        this.ingestJoin(event); count++;
      }
      cursor=parsed.next_cursor;
      if(!cursor) return count;
      if(cursors.has(cursor)) throw new Error('QQ 返回重复分页游标，已停止拉取');
      cursors.add(cursor);
    }
    throw new Error('已拉取 1000 条申请，仍有更多，请先处理后再次拉取');
  }
}
