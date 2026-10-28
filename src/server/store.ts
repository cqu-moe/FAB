import { DatabaseSync } from 'node:sqlite';
import { defaultSettings, type Group, type Person, type PersonInput, type RecordItem, type RecordStatus, type Decision, type Settings } from '../shared.js';

type Row = Record<string, string | number | null>;
export type StoredRecord = RecordItem & { externalId: string; payload: string; automatic: boolean; revision: number; personId: number | null; recalled: boolean };
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        last_event_at INTEGER, strategy_id TEXT, whitelist_synced TEXT NOT NULL DEFAULT '[]', whitelist_error TEXT
      );
      CREATE TABLE IF NOT EXISTS roster (
        id INTEGER PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), name TEXT NOT NULL,
        student_id TEXT NOT NULL, qq TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', member_openid TEXT,
        UNIQUE(group_id, student_id), UNIQUE(group_id, member_openid)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS roster_qq ON roster(group_id,qq) WHERE qq <> '';
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), kind TEXT NOT NULL, external_id TEXT NOT NULL,
        member_openid TEXT NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, payload TEXT NOT NULL,
        reason TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL, error TEXT, outcome TEXT, automatic INTEGER NOT NULL, revision INTEGER NOT NULL,
        person_id INTEGER REFERENCES roster(id) ON DELETE SET NULL, recalled INTEGER NOT NULL DEFAULT 0,
        UNIQUE(group_id,kind,external_id)
      );
      CREATE INDEX IF NOT EXISTS record_queue ON records(status,kind,id);
      CREATE INDEX IF NOT EXISTS record_group ON records(group_id,id);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, group_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  group(id: string): Group | undefined {
    const r = this.db.prepare(`SELECT g.*, (SELECT count(*) FROM roster WHERE group_id=g.id) AS roster_count,
      (SELECT count(*) FROM records WHERE group_id=g.id AND status IN ('review','failed','observed','expired')) AS review_count FROM groups g WHERE id=?`).get(id) as Row | undefined;
    return r ? { id:String(r.id), name:String(r.name), settings:JSON.parse(String(r.settings)), revision:Number(r.revision),
      lastEventAt:r.last_event_at === null ? null : Number(r.last_event_at), strategyId:r.strategy_id as string | null,
      whitelistSynced:JSON.parse(String(r.whitelist_synced)), whitelistError:r.whitelist_error as string | null,
      rosterCount:Number(r.roster_count), reviewCount:Number(r.review_count) } : undefined;
  }
  groups(): Group[] { return this.db.prepare('SELECT id FROM groups ORDER BY name').all().map(r => this.group(String(r.id))!); }
  addGroup(id: string, name: string) { this.db.prepare('INSERT INTO groups(id,name,settings) VALUES(?,?,?)').run(id,name,JSON.stringify(defaultSettings())); }
  discover(id: string) {
    this.db.prepare('INSERT OR IGNORE INTO groups(id,name,settings) VALUES(?,?,?)').run(id,`待配置群 ${id.slice(-6)}`,JSON.stringify(defaultSettings()));
    this.db.prepare('UPDATE groups SET last_event_at=? WHERE id=?').run(Date.now(),id);
  }
  saveGroup(id: string, name: string, settings: Settings, revision: number) {
    const result = this.db.prepare('UPDATE groups SET name=?,settings=?,revision=revision+1 WHERE id=? AND revision=?').run(name,JSON.stringify(settings),id,revision);
    if (!result.changes) throw new Error('配置已被其他页面更新，请刷新后重新修改');
    this.audit(id,'更新群配置');
  }
  roster(id: string): Person[] {
    return this.db.prepare('SELECT * FROM roster WHERE group_id=? ORDER BY student_id').all(id).map(r => ({ id:Number(r.id), name:String(r.name), studentId:String(r.student_id), qq:String(r.qq), phone:String(r.phone), memberOpenid:r.member_openid as string | null }));
  }
  addPeople(groupId: string, people: PersonInput[]) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO roster(group_id,name,student_id,qq,phone) VALUES(?,?,?,?,?)');
      for (const p of people) insert.run(groupId,p.name,p.studentId,p.qq,p.phone);
      this.audit(groupId,`新增名单 ${people.length} 人`);
    });
  }
  audit(groupId: string, action: string) { this.db.prepare('INSERT INTO audit(group_id,action,created_at) VALUES(?,?,?)').run(groupId,action,Date.now()); }
  record(id: number, groupId?: string): StoredRecord | undefined {
    const r = (groupId ? this.db.prepare('SELECT * FROM records WHERE id=? AND group_id=?').get(id,groupId) : this.db.prepare('SELECT * FROM records WHERE id=?').get(id)) as Row | undefined;
    return r ? this.mapRecord(r) : undefined;
  }
  private mapRecord(r: Row): StoredRecord {
    return { id:Number(r.id), groupId:String(r.group_id), kind:r.kind as 'join'|'message', externalId:String(r.external_id),
      memberOpenid:String(r.member_openid), username:String(r.username), content:String(r.content), payload:String(r.payload),
      reason:String(r.reason), decision:r.decision as Decision, status:r.status as RecordStatus, createdAt:Number(r.created_at),
      occurredAt:Number(r.occurred_at), error:r.error as string|null, outcome:r.outcome as string|null,
      automatic:Boolean(r.automatic), revision:Number(r.revision), personId:r.person_id === null ? null : Number(r.person_id), recalled:Boolean(r.recalled) };
  }
  records(groupId: string, before = Number.MAX_SAFE_INTEGER): RecordItem[] {
    return this.db.prepare('SELECT * FROM records WHERE group_id=? AND id<? ORDER BY id DESC LIMIT 100').all(groupId,before).map(r => {
      const { payload, externalId, automatic, revision, personId, recalled, ...publicRecord } = this.mapRecord(r as Row);
      return publicRecord;
    });
  }
  insertRecord(r: Omit<StoredRecord,'id'|'createdAt'|'error'|'outcome'|'recalled'>) {
    this.db.prepare(`INSERT OR IGNORE INTO records(group_id,kind,external_id,member_openid,username,content,payload,reason,decision,status,created_at,occurred_at,automatic,revision,person_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.groupId,r.kind,r.externalId,r.memberOpenid,r.username,r.content,r.payload,r.reason,r.decision,r.status,Date.now(),r.occurredAt,Number(r.automatic),r.revision,r.personId);
  }
  finish(id: number, status: RecordStatus, outcome: string | null, error: string | null = null) {
    this.db.prepare('UPDATE records SET status=?,outcome=?,error=? WHERE id=?').run(status,outcome,error,id);
  }
  recover() { this.db.prepare("UPDATE records SET status='failed',error='服务在执行期间重启，结果可能已生效，请先核对 QQ 后再重试' WHERE status='processing'").run(); }
  cleanup(days: number) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM records WHERE created_at<? AND status NOT IN ('queued','processing')").run(Date.now()-days*86400000);
      this.db.prepare('DELETE FROM seen WHERE created_at<?').run(Date.now()-7*86400000);
      this.db.prepare('DELETE FROM audit WHERE created_at<?').run(Date.now()-days*86400000);
    });
  }
}
