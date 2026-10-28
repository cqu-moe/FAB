import { z } from 'zod';
import { joinEventSchema, opaqueId, type JoinEvent, type MessageData, type Person, type PreviewResult, type Settings } from '../shared.js';

const normal = (value: string) => value.normalize('NFKC').trim().replace(/[\t ]+/g, ' ');

export function decideJoin(event: JoinEvent, settings: Settings, roster: Person[]): PreviewResult {
  if (settings.holdRisky && event.risk_tips.trim()) return { decision: 'review', reason: 'QQ 提供了安全风险提示' };
  if (settings.whitelistMembers.includes(event.member_openid)) return { decision: 'approve', reason: '命中本群成员 OpenID 白名单' };
  const info = event.verify_info;
  let pairs: { question: string; answer: string }[] = [];
  if (info?.method === 'admin_review_qa') pairs = info.review_qa_list ?? [];
  if (info?.method === 'verify_message') {
    pairs = (info.verify_message ?? '').split(/[\n;；]/).map(line => {
      const match = normal(line).match(/^([^:=]+)[:=]\s*(.*)$/);
      return { question: match?.[1]?.trim() ?? '', answer: match?.[2]?.trim() ?? '' };
    });
  }
  const read = (key: string) => pairs.filter(p => normal(p.question) === normal(key)).map(p => normal(p.answer));
  const names = read(settings.nameQuestion), ids = read(settings.studentQuestion);
  if (names.length !== 1 || ids.length !== 1 || !names[0] || !ids[0]) return { decision: 'review', reason: '姓名或学号缺失、重复或格式无法解析' };
  const person = roster.find(p => normal(p.studentId) === ids[0] && normal(p.name) === names[0]);
  if (!person) return { decision: settings.unmatched, reason: '姓名与学号未同时匹配本群名单' };
  if (person.memberOpenid && person.memberOpenid !== event.member_openid) return { decision: 'review', reason: '该人员已关联其他成员 OpenID，需核实身份' };
  const bound = roster.find(p => p.memberOpenid === event.member_openid && p.id !== person.id);
  if (bound) return { decision: 'review', reason: '该成员 OpenID 已关联其他人员' };
  return { decision: 'approve', reason: '姓名与学号精确匹配名单（仅名单核对，非本人身份认证）', personId: person.id };
}

const messageSchema = z.object({
  id: z.string().min(1).max(2048), group_openid: opaqueId,
  timestamp: z.string().datetime({ offset: true }),
  author: z.object({ member_openid: opaqueId, username: z.string().max(200).default(''), member_role: z.string().default('unknown'), bot: z.boolean().default(false) }),
  content: z.string().max(64000).default(''), attachments: z.array(z.unknown()).max(100).optional(),
  ark_data: z.unknown().optional(), msg_elements: z.array(z.unknown()).max(100).optional(),
});

export function parseMessage(input: unknown): MessageData {
  const m = messageSchema.parse(input);
  let media = Boolean(m.attachments?.length);
  const chunks = [m.content];
  let visited = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || ++visited > 200 || !node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.content === 'string') chunks.push(n.content.slice(0,10000));
    if (Array.isArray(n.attachments) && n.attachments.length) media = true;
    if (n.fields && typeof n.fields === 'object') {
      const fields = n.fields as Record<string, unknown>;
      for (const k of ['title', 'desc', 'jump_url', 'source', 'address']) if (typeof fields[k] === 'string') chunks.push(fields[k].slice(0,10000));
      if (fields.preview) media = true;
    }
    if (n.ark_data) walk(n.ark_data, depth + 1);
    if (Array.isArray(n.msg_elements)) n.msg_elements.forEach(item => walk(item, depth + 1));
  };
  walk(m.ark_data, 0);
  m.msg_elements?.forEach(e => walk(e, 0));
  return { id:m.id, group_openid:m.group_openid, memberOpenid:m.author.member_openid, username:m.author.username,
    role:m.author.member_role, bot:m.author.bot, timestamp:Date.parse(m.timestamp), text:chunks.join('\n').slice(0,64000), media };
}

export function decideMessage(message: MessageData, settings: Settings): PreviewResult {
  if (message.bot || message.role === 'owner' || message.role === 'admin') return { decision:'ignore', reason:'群主、管理员或机器人消息不执行自动处置' };
  if (settings.exemptMembers.includes(message.memberOpenid)) return { decision:'ignore', reason:'命中本群广告豁免名单' };
  const text = normal(message.text).toLowerCase().replace(/[\u200b-\u200d\ufeff]/g, '');
  const phrase = settings.blockedPhrases.find(p => text.includes(normal(p).toLowerCase()));
  // shortcut: only explicit HTTP(S) links; add OCR/semantic review when those inputs are required.
  const urls = text.match(/https?:\/\/[^\s<>"'\u3000]+/g) ?? [];
  const domain = settings.blockedDomains.find(d => urls.some(url => {
    try { const host = new URL(url).hostname; return host === d || host.endsWith(`.${d}`); } catch { return false; }
  }));
  if (phrase || domain) {
    if (message.role !== 'member') return { decision:'review', reason:'命中广告规则，但发送者权限未知，需复核' };
    return { decision:settings.moderationMode === 'recall_mute' ? 'recall_mute' : 'recall', reason:phrase ? `命中禁止短语：${phrase}` : `命中禁止域名：${domain}` };
  }
  if (message.media && settings.reviewMedia) return { decision:'review', reason:'包含图片或附件，首版不进行 OCR/语义判断，请人工查看原消息' };
  return { decision:'ignore', reason:'未命中当前文本或链接规则' };
}

export function previewJoin(text: string, groupId: string): JoinEvent {
  return joinEventSchema.parse({ group_openid:groupId, member_openid:'preview', join_request_id:'preview', verify_info:{ method:'verify_message', verify_message:text } });
}
