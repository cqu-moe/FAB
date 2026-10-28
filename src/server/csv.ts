import { personSchema, type PersonInput } from '../shared.js';

export function parseRosterCsv(csv: string): PersonInput[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const input = csv.replace(/^\ufeff/,'');
  for (let i=0; i<input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i+1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field=''; closed=false;
      if (char !== ',') { if(row.some(v=>v.trim())) rows.push(row); row=[]; if(char==='\r' && input[i+1]==='\n') i++; }
    } else if (closed || char === '"') throw new Error('CSV 引号格式不正确');
    else field += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(field); if(row.some(v=>v.trim())) rows.push(row);
  const header = rows.shift()?.map(v=>v.trim());
  if (!header || header.join(',') !== '姓名,学号,QQ号,手机号') throw new Error('CSV 表头须为：姓名,学号,QQ号,手机号');
  if (!rows.length || rows.length>10000) throw new Error('每次导入 1–10000 人');
  const ids = new Set<string>(), qqs = new Set<string>();
  return rows.map((values,index) => {
    if (values.length !== 4) throw new Error(`第 ${index+2} 行须为 4 列`);
    const parsed = personSchema.safeParse({ name:values[0], studentId:values[1], qq:values[2], phone:values[3] });
    if (!parsed.success) throw new Error(`第 ${index+2} 行：${parsed.error.issues[0].message}`);
    const p=parsed.data;
    if(ids.has(p.studentId) || (p.qq && qqs.has(p.qq))) throw new Error(`第 ${index+2} 行学号或 QQ 号重复`);
    ids.add(p.studentId); if(p.qq) qqs.add(p.qq);
    return p;
  });
}
