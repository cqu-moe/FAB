import { z } from 'zod';

export const opaqueId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const qq = z.string().trim().regex(/^[1-9][0-9]{4,19}$/, 'QQ 号须为 5–20 位数字');
const lines = z.array(z.string().trim().min(1).max(200)).max(500);
export const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  joinMode: z.enum(['review', 'auto']).default('review'),
  nameQuestion: z.string().trim().min(1).max(100).default('姓名'),
  studentQuestion: z.string().trim().min(1).max(100).default('学号'),
  unmatched: z.enum(['review', 'decline']).default('review'),
  holdRisky: z.boolean().default(true),
  whitelistQQ: z.array(qq).max(10000).default([]),
  whitelistMembers: z.array(opaqueId).max(1000).default([]),
  moderationEnabled: z.boolean().default(false),
  moderationMode: z.enum(['observe', 'recall', 'recall_mute']).default('observe'),
  blockedPhrases: lines.default([]),
  blockedDomains: z.array(z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, '域名不含协议或路径')).max(500).default([]),
  exemptMembers: z.array(opaqueId).max(1000).default([]),
  muteMinutes: z.number().int().min(1).max(43200).default(10),
  reviewMedia: z.boolean().default(true),
}).refine(s => s.nameQuestion.normalize('NFKC').replace(/ +/g,' ') !== s.studentQuestion.normalize('NFKC').replace(/ +/g,' '), '姓名和学号的问题名称不能相同');
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): Settings => settingsSchema.parse({});
export const groupInputSchema = z.object({ id: opaqueId, name: z.string().trim().min(1).max(100) });
export const groupUpdateSchema = z.object({ name: z.string().trim().min(1).max(100), settings: settingsSchema, revision: z.number().int().nonnegative() });
export const personSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[^\r\n\t]+$/).transform(s=>s.normalize('NFKC').replace(/ +/g,' ')),
  studentId: z.string().trim().min(1).max(64).regex(/^[^\r\n\t]+$/).transform(s=>s.normalize('NFKC').replace(/ +/g,' ')),
  qq: z.union([qq, z.literal('')]).default(''),
  phone: z.string().trim().max(32).regex(/^[+0-9 ()-]*$/).default(''),
});
export type PersonInput = z.infer<typeof personSchema>;
export type Person = PersonInput & { id: number; memberOpenid: string | null };
export type Group = {
  id: string; name: string; settings: Settings; revision: number;
  lastEventAt: number | null; strategyId: string | null; whitelistSynced: string[];
  whitelistError: string | null; rosterCount: number; reviewCount: number;
};
export type RecordStatus = 'review' | 'queued' | 'processing' | 'succeeded' | 'failed' | 'observed' | 'ignored' | 'expired';
export type Decision = 'approve' | 'decline' | 'recall' | 'recall_mute' | 'review' | 'ignore';
export type RecordItem = {
  id: number; groupId: string; kind: 'join' | 'message'; memberOpenid: string;
  username: string; content: string; reason: string; decision: Decision;
  status: RecordStatus; createdAt: number; occurredAt: number;
  error: string | null; outcome: string | null;
};
export type GroupDetail = { group: Group; roster: Person[]; records: RecordItem[] };
export type SystemStatus = { qqConfigured: boolean; appId: string; webhookPath: string; retentionDays: number };
export type PreviewResult = { decision: Decision; reason: string; personId?: number };

// OneBot is deliberately absent: this service only consumes signed official QQ events.
export const joinEventSchema = z.object({
  group_openid: opaqueId, member_openid: opaqueId,
  join_request_id: z.string().min(1).max(2048),
  username: z.string().max(200).default(''), risk_tips: z.string().max(1000).default(''),
  apply_at: z.string().optional(), apply_source: z.string().optional(),
  auto_approved: z.object({ strategy_id: z.string() }).optional(),
  verify_info: z.object({
    method: z.string(), verify_message: z.string().max(10000).optional(),
    review_qa_list: z.array(z.object({ question: z.string().max(500), answer: z.string().max(2000) })).max(20).optional(),
  }).optional(),
});
export type JoinEvent = z.infer<typeof joinEventSchema>;
export type MessageData = {
  id: string; group_openid: string; memberOpenid: string; username: string;
  role: string; bot: boolean; text: string; media: boolean; timestamp: number;
};
