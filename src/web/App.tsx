import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { formatDateTime, formatTime, linesToText, sameLines, textOrDash, textToLines } from './helpers';
import { type Group, type GroupDetail, type Person, type PersonInput, type PreviewResult, type RecordItem, type Settings, type SystemStatus } from '../shared';

type SessionResponse = { authenticated: true; status: SystemStatus };
type GroupsResponse = { groups: Group[]; status: SystemStatus };
type GroupMutationResponse = { group: Group };
type RecordsResponse = { records: RecordItem[] };
type CountResponse = { count: number };
type OkResponse = { ok: true };
type ImportResponse = { people: PersonInput[]; count: number };

type Tab = 'overview' | 'admission' | 'roster' | 'moderation' | 'review' | 'preview';
type PersonDraft = { id: number | null; values: PersonInput };
type GroupDraft = {
  name: string;
  baseName: string;
  revision: number;
  baseSettings: Settings;
  settings: Settings;
  whitelistQQText: string;
  whitelistMembersText: string;
  blockedPhrasesText: string;
  blockedDomainsText: string;
  exemptMembersText: string;
  muteMinutesText: string;
};
type Workspace = { draft: GroupDraft; person: PersonDraft | null; csv: string; conflict: boolean };
type ControlState = {
  selectedGroupId: string | null;
  newGroupId: string;
  newGroupName: string;
  workspaces: Record<string, Workspace>;
};
type Confirmation = { title: string; body: string; confirmLabel: string; danger: boolean; action: () => void | Promise<void> };

const legacyStorageKey = 'fab-qq-control-v1';
const emptyControlState: ControlState = { selectedGroupId: null, newGroupId: '', newGroupName: '', workspaces: {} };
const emptyPerson: PersonInput = { name: '', studentId: '', qq: '', phone: '' };

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'admission', label: '入群' },
  { id: 'roster', label: '名册' },
  { id: 'moderation', label: '治理' },
  { id: 'review', label: '审核' },
  { id: 'preview', label: '预览' },
];

const decisionLabels: Record<string, string> = {
  approve: '通过',
  decline: '拒绝',
  recall: '撤回',
  recall_mute: '撤回并禁言',
  review: '人工审核',
  ignore: '忽略',
};

const statusLabels: Record<string, string> = {
  review: '待审核',
  queued: '已排队',
  processing: '执行中',
  succeeded: '已成功',
  failed: '执行失败',
  observed: '待复核',
  ignored: '已忽略',
  expired: '已过期',
};

const emptyPersonDraft = (): PersonDraft => ({ id: null, values: { ...emptyPerson } });

const draftFromGroup = (group: Group): GroupDraft => ({
  name: group.name,
  baseName: group.name,
  revision: group.revision,
  baseSettings: group.settings,
  settings: group.settings,
  whitelistQQText: linesToText(group.settings.whitelistQQ),
  whitelistMembersText: linesToText(group.settings.whitelistMembers),
  blockedPhrasesText: linesToText(group.settings.blockedPhrases),
  blockedDomainsText: linesToText(group.settings.blockedDomains),
  exemptMembersText: linesToText(group.settings.exemptMembers),
  muteMinutesText: String(group.settings.muteMinutes),
});

const workspaceFromGroup = (group: Group): Workspace => ({
  draft: draftFromGroup(group),
  person: null,
  csv: '',
  conflict: false,
});

const sameSettings = (left: Settings, right: Settings) => JSON.stringify(left) === JSON.stringify(right);

const draftHasEdits = (draft: GroupDraft, group: Pick<Group, 'name' | 'settings'>) =>
  draft.name.trim() !== group.name ||
  !sameSettings(draft.settings, group.settings) ||
  !sameLines(draft.whitelistQQText, group.settings.whitelistQQ) ||
  !sameLines(draft.whitelistMembersText, group.settings.whitelistMembers) ||
  !sameLines(draft.blockedPhrasesText, group.settings.blockedPhrases) ||
  !sameLines(draft.blockedDomainsText, group.settings.blockedDomains) ||
  !sameLines(draft.exemptMembersText, group.settings.exemptMembers) ||
  draft.muteMinutesText.trim() !== String(group.settings.muteMinutes);

export function refreshWorkspace(previous: Workspace | undefined, group: Group, preserve: boolean): Workspace {
  if (!preserve || !previous) return workspaceFromGroup(group);
  const edited = draftHasEdits(previous.draft, { name: previous.draft.baseName, settings: previous.draft.baseSettings });
  const conflict = edited && (previous.draft.baseName !== group.name || !sameSettings(previous.draft.baseSettings, group.settings));
  return {
    ...previous,
    draft: edited ? { ...previous.draft, revision: group.revision } : draftFromGroup(group),
    conflict,
  };
}

const parsedSettings = (draft: GroupDraft): Settings => {
  const muteMinutes = Number(draft.muteMinutesText.trim());
  return {
    ...draft.settings,
    muteMinutes,
    whitelistQQ: textToLines(draft.whitelistQQText),
    whitelistMembers: textToLines(draft.whitelistMembersText),
    blockedPhrases: textToLines(draft.blockedPhrasesText),
    blockedDomains: textToLines(draft.blockedDomainsText).map(value => value.toLowerCase()),
    exemptMembers: textToLines(draft.exemptMembersText),
  };
};

const isValidDraft = (draft: GroupDraft): string | null => {
  if (!draft.name.trim()) return '群名称不能为空';
  if (!draft.settings.nameQuestion.trim()) return '姓名标签不能为空';
  if (!draft.settings.studentQuestion.trim()) return '学号标签不能为空';
  if (draft.settings.nameQuestion.trim() === draft.settings.studentQuestion.trim()) return '姓名和学号的问题标签不能相同';
  if (!Number.isInteger(Number(draft.muteMinutesText.trim())) || Number(draft.muteMinutesText.trim()) < 1 || Number(draft.muteMinutesText.trim()) > 43200) {
    return '禁言时长须为 1–43200 的整数分钟';
  }
  if (textToLines(draft.whitelistQQText).some(value => !/^[1-9][0-9]{4,19}$/.test(value))) return 'QQ 白名单中有格式不正确的 QQ 号';
  if (textToLines(draft.blockedDomainsText).some(value => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value))) {
    return '禁止域名须为小写裸域名，不含协议或路径';
  }
  return null;
};

const personValues = (person: Person): PersonInput => ({
  name: person.name,
  studentId: person.studentId,
  qq: person.qq,
  phone: person.phone,
});

const errorText = (error: unknown): string => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
};

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'anonymous' | 'ready'>('loading');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupsError, setGroupsError] = useState('');
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [hasMoreRecords, setHasMoreRecords] = useState(false);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState<'pending' | 'all' | 'outcome'>('pending');

  const [tab, setTab] = useState<Tab>('overview');
  const [controlState, setControlState] = useState<ControlState>(emptyControlState);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [notice, setNotice] = useState('');
  const [whitelistBusy, setWhitelistBusy] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState('');
  const [importPreview, setImportPreview] = useState<ImportResponse | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [previewKind, setPreviewKind] = useState<'join' | 'message'>('join');
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const confirmDialog = useRef<HTMLDialogElement>(null);
  const recordPollCount = useRef(0);
  const selectedGroupIdRef = useRef<string | null>(null);
  const detailGenerationRef = useRef(0);
  const selectedGroup = detail?.group ?? groups?.find(group => group.id === selectedGroupId) ?? null;
  const workspace = selectedGroupId ? controlState.workspaces[selectedGroupId] ?? (detail ? workspaceFromGroup(detail.group) : null) : null;
  const draft = workspace?.draft ?? null;
  const dirty = Boolean(detail && draft && draftHasEdits(draft, detail.group));
  const operationBusy = settingsBusy || personBusy || importBusy || previewBusy || whitelistBusy || pullBusy || Boolean(actionBusy);
  selectedGroupIdRef.current = selectedGroupId;

  useEffect(() => {
    try {
      localStorage.removeItem(legacyStorageKey);
    } catch {
      // Cleanup is best-effort when a browser blocks storage access.
    }
  }, []);

  useEffect(() => {
    const dialog = confirmDialog.current;
    if (!dialog) return;
    if (confirmation && !dialog.open) dialog.showModal();
    if (!confirmation && dialog.open) dialog.close();
  }, [confirmation]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const session = await api<SessionResponse>('/api/session');
        if (cancelled) return;
        setStatus(session.status);
        setAuthState('ready');
        void loadGroups(true, session.status);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthState('anonymous');
          return;
        }
        setLoginError(errorText(error));
        setAuthState('anonymous');
      }
    };
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authState !== 'ready' || !selectedGroupId || detail?.group.id === selectedGroupId) return;
    void loadDetail(selectedGroupId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, selectedGroupId, detail?.group.id]);

  const activeEditing = Boolean(
    dirty ||
    workspace?.person ||
    workspace?.csv.trim() ||
    previewText.trim() ||
    controlState.newGroupId.trim() ||
    controlState.newGroupName.trim() ||
    confirmation,
  );

  useEffect(() => {
    if (authState !== 'ready') return;
    const timer = window.setInterval(() => {
      if (document.hidden || activeEditing) return;
      void refreshGroups(false);
      if (selectedGroupId) void loadDetail(selectedGroupId, false);
    }, 30000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, activeEditing, selectedGroupId]);

  const pendingSignature = useMemo(
    () => (detail?.records ?? []).filter(record => record.status === 'queued' || record.status === 'processing').map(record => `${record.id}:${record.status}`).join(','),
    [detail?.records],
  );

  useEffect(() => {
    if (tab !== 'review' || !pendingSignature || !selectedGroupId) return;
    const timer = window.setInterval(() => {
      if (document.hidden || recordPollCount.current >= 20) return;
      recordPollCount.current += 1;
      void api<RecordsResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/records`)
        .then(response => {
          if (selectedGroupIdRef.current !== selectedGroupId) return;
          setDetail(current => {
            if (!current || current.group.id !== selectedGroupId) return current;
            const old = current.records.filter(record => !response.records.some(item => item.id === record.id));
            return { ...current, records: [...response.records, ...old] };
          });
        })
        .catch(error => setRecordError(errorText(error)));
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedGroupId, pendingSignature]);

  useEffect(() => {
    recordPollCount.current = 0;
  }, [tab, selectedGroupId]);

  async function loadGroups(initial = false, knownStatus?: SystemStatus) {
    setGroupsError('');
    if (initial) setGroupsBusy(true);
    try {
      const response = await api<GroupsResponse>('/api/groups');
      setGroups(response.groups);
      setStatus(knownStatus ?? response.status);
      setSelectedGroupId(current => {
        if (current && response.groups.some(group => group.id === current)) return current;
        return response.groups[0]?.id ?? null;
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setGroupsError(errorText(error));
      if (initial) setGroups(null);
    } finally {
      if (initial) setGroupsBusy(false);
    }
  }

  async function refreshGroups(showBusy = true) {
    if (showBusy) setGroupsBusy(true);
    try {
      await loadGroups(false);
    } finally {
      if (showBusy) setGroupsBusy(false);
    }
  }

  async function loadDetail(groupId: string, preserveDraft: boolean) {
    const generation = ++detailGenerationRef.current;
    setDetailError('');
    setDetailBusy(true);
    try {
      const response = await api<GroupDetail>(`/api/groups/${encodeURIComponent(groupId)}`);
      if (selectedGroupIdRef.current !== groupId || detailGenerationRef.current !== generation) return;
      setDetail(response);
      setControlState(state => ({ ...state, workspaces: { ...state.workspaces, [groupId]: refreshWorkspace(state.workspaces[groupId], response.group, preserveDraft) } }));
      setHasMoreRecords(response.records.length === 100);
      setRecordError('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setDetailError(errorText(error));
    } finally {
      if (selectedGroupIdRef.current === groupId && detailGenerationRef.current === generation) setDetailBusy(false);
    }
  }

  function resetSession() {
    setAuthState('anonymous');
    selectedGroupIdRef.current = null;
    detailGenerationRef.current += 1;
    setStatus(null);
    setGroups(null);
    setSelectedGroupId(null);
    setDetail(null);
    setPassword('');
    setNotice('');
    setControlState(emptyControlState);
    setImportPreview(null);
    setImportError('');
    setPersonError('');
    setPreviewText('');
    setPreviewResult(null);
    setPreviewError('');
    setRecordError('');
    setConfirmation(null);
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const response = await api<SessionResponse>('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      setStatus(response.status);
      setAuthState('ready');
      setPassword('');
      await loadGroups(true, response.status);
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    try {
      await api<OkResponse>('/api/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch (error) {
      resetSession();
      setLoginError(`退出请求失败，服务端会话可能仍有效：${errorText(error)}`);
      return;
    }
    resetSession();
  }

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    const id = controlState.newGroupId.trim();
    const name = controlState.newGroupName.trim();
    if (!id || !name) {
      setGroupsError('群 OpenID 和群名称都不能为空');
      return;
    }
    setGroupsBusy(true);
    setGroupsError('');
    try {
      await api<GroupMutationResponse>('/api/groups', { method: 'POST', body: JSON.stringify({ id, name }) });
      setControlState(state => ({ ...state, newGroupId: '', newGroupName: '' }));
      setNotice('群已创建，请继续配置入群策略。');
      await loadGroups(false);
      await selectGroup(id);
      setTab('admission');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) resetSession();
      else setGroupsError(errorText(error));
    } finally {
      setGroupsBusy(false);
    }
  }

  async function selectGroup(groupId: string) {
    if (operationBusy) return;
    selectedGroupIdRef.current = groupId;
    detailGenerationRef.current += 1;
    setSelectedGroupId(groupId);
    setDetail(null);
    setDetailError('');
    setRecordError('');
    setSettingsError('');
    setPersonError('');
    setImportError('');
    setNotice('');
    setImportPreview(null);
    setTab('overview');
    setPreviewText('');
    setPreviewResult(null);
    setPreviewError('');
    setControlState(state => ({ ...state, selectedGroupId: groupId }));
    await loadDetail(groupId, true);
  }

  function updateDraft(patch: Partial<GroupDraft>) {
    if (!selectedGroupId || !draft) return;
    setControlState(state => {
      const current = state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: { ...current, draft: { ...current.draft, ...patch } },
        },
      };
    });
  }

  function updateSettings(patch: Partial<Settings>) {
    if (!draft) return;
    updateDraft({ settings: { ...draft.settings, ...patch } });
  }

  function updatePerson(patch: Partial<PersonInput>) {
    if (!selectedGroupId || !workspace?.person) return;
    setControlState(state => {
      const current = state.workspaces[selectedGroupId];
      if (!current?.person) return state;
      return {
        ...state,
        workspaces: { ...state.workspaces, [selectedGroupId]: { ...current, person: { ...current.person, values: { ...current.person.values, ...patch } } } },
      };
    });
  }

  function setPersonDraft(personDraft: PersonDraft | null) {
    if (!selectedGroupId) return;
    setControlState(state => {
      const current = state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return { ...state, workspaces: { ...state.workspaces, [selectedGroupId]: { ...current, person: personDraft } } };
    });
  }

  function setCsv(csv: string) {
    if (!selectedGroupId) return;
    setImportPreview(null);
    setControlState(state => {
      const current = state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return { ...state, workspaces: { ...state.workspaces, [selectedGroupId]: { ...current, csv } } };
    });
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedGroupId || !draft || !detail || workspace?.conflict) return;
    const invalid = isValidDraft(draft);
    if (invalid) {
      setSettingsError(invalid);
      return;
    }
    setSettingsBusy(true);
    setSettingsError('');
    setNotice('');
    try {
      const settings = parsedSettings(draft);
      const response = await api<GroupMutationResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: draft.name.trim(), settings, revision: draft.revision }),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setDetail(current => (current?.group.id === selectedGroupId ? { ...current, group: response.group } : current));
      setControlState(state => ({
        ...state,
        workspaces: { ...state.workspaces, [selectedGroupId]: { ...(state.workspaces[selectedGroupId] ?? workspaceFromGroup(response.group)), draft: draftFromGroup(response.group), conflict: false } },
      }));
      setNotice(response.group.whitelistError
        ? '本地配置已保存，但 QQ 官方白名单同步未完成。'
        : '本地配置已保存。');
      await loadDetail(selectedGroupId, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      const message = errorText(error);
      setSettingsError(message);
      if (error instanceof ApiError && error.status === 409) {
        setControlState(state => {
          const current = state.workspaces[selectedGroupId];
          if (!current) return state;
          return { ...state, workspaces: { ...state.workspaces, [selectedGroupId]: { ...current, conflict: true } } };
        });
        await loadDetail(selectedGroupId, true);
      }
    } finally {
      setSettingsBusy(false);
    }
  }

  async function syncWhitelist() {
    if (!selectedGroupId) return;
    setWhitelistBusy(true);
    setNotice('');
    try {
      await api<OkResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/whitelist/sync`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice('QQ 官方白名单同步已由服务端确认成功。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setNotice(errorText(error));
    } finally {
      setWhitelistBusy(false);
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
    }
  }

  async function pullRequests() {
    if (!selectedGroupId) return;
    setPullBusy(true);
    setNotice('');
    try {
      const response = await api<CountResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/requests/pull`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice(response.count === 0 ? '没有拉取到新的入群申请。' : `拉取到 ${response.count} 条入群申请。`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setNotice(errorText(error));
    } finally {
      setPullBusy(false);
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
    }
  }

  async function savePerson(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedGroupId || !workspace?.person || !detail) return;
    const person = workspace.person;
    if (!person.values.name.trim() || !person.values.studentId.trim()) {
      setPersonError('姓名和学号都不能为空');
      return;
    }
    setPersonBusy(true);
    setPersonError('');
    try {
      const path = person.id === null
        ? `/api/groups/${encodeURIComponent(selectedGroupId)}/roster`
        : `/api/groups/${encodeURIComponent(selectedGroupId)}/roster/${person.id}`;
      if (person.id === null) {
        await api<CountResponse>(path, { method: 'POST', body: JSON.stringify({ people: [person.values] }) });
      } else {
        await api<OkResponse>(path, { method: 'PUT', body: JSON.stringify(person.values) });
      }
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setPersonDraft(null);
      setNotice(person.id === null ? '已添加名单人员。' : '已保存名单人员。');
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setPersonError(errorText(error));
    } finally {
      setPersonBusy(false);
    }
  }

  function askDeletePerson(person: Person) {
    setConfirmation({
      title: '删除名单人员',
      body: `确定删除「${person.name}（${person.studentId}）」？此操作会立即保存。`,
      confirmLabel: '删除人员',
      danger: true,
      action: async () => {
        if (!selectedGroupId) return;
        setPersonBusy(true);
        setPersonError('');
        try {
          await api<OkResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/roster/${person.id}`, { method: 'DELETE' });
          if (selectedGroupIdRef.current !== selectedGroupId) return;
          if (workspace?.person?.id === person.id) setPersonDraft(null);
          setNotice('已删除名单人员。');
          await loadDetail(selectedGroupId, true);
          await loadGroups(false);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) resetSession();
          else setPersonError(errorText(error));
        } finally {
          setPersonBusy(false);
        }
      },
    });
  }

  async function previewImport() {
    if (!selectedGroupId || !workspace) return;
    setImportBusy(true);
    setImportError('');
    try {
      const response = await api<ImportResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/roster/import`, {
        method: 'POST',
        body: JSON.stringify({ csv: workspace.csv, commit: false }),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setImportPreview(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setImportError(errorText(error));
    } finally {
      setImportBusy(false);
    }
  }

  async function commitImport() {
    if (!selectedGroupId || !workspace || !importPreview) return;
    setImportBusy(true);
    setImportError('');
    try {
      await api<ImportResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/roster/import`, {
        method: 'POST',
        body: JSON.stringify({ csv: workspace.csv, commit: true }),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setImportPreview(null);
      setCsv('');
      setNotice(`已导入 ${importPreview.count} 名人员。`);
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setImportError(errorText(error));
    } finally {
      setImportBusy(false);
    }
  }

  async function loadOlderRecords() {
    if (!selectedGroupId || !detail?.records.length) return;
    const before = detail.records[detail.records.length - 1].id;
    setRecordsBusy(true);
    setRecordError('');
    try {
      const response = await api<RecordsResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/records?before=${before}`);
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setDetail(current => {
        if (!current || current.group.id !== selectedGroupId) return current;
        const known = new Set(current.records.map(record => record.id));
        return { ...current, records: [...current.records, ...response.records.filter(record => !known.has(record.id))] };
      });
      setHasMoreRecords(response.records.length === 100);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setRecordError(errorText(error));
    } finally {
      setRecordsBusy(false);
    }
  }

  async function runRecordAction(record: RecordItem, action: 'approve' | 'decline' | 'ignore' | 'recall' | 'recall_mute') {
    if (!selectedGroupId) return;
    const key = `${record.id}:${action}`;
    setActionBusy(key);
    setRecordError('');
    setNotice('');
    recordPollCount.current = 0;
    try {
      await api<OkResponse>(`/api/groups/${encodeURIComponent(selectedGroupId)}/records/${record.id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice('操作已提交到后台队列，请等待执行结果。');
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
      setTab('review');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setRecordError(errorText(error));
    } finally {
      setActionBusy(null);
    }
  }

  function askRecordAction(record: RecordItem, action: 'decline' | 'recall' | 'recall_mute') {
    const labels = {
      decline: ['拒绝入群', '确定拒绝这条入群申请？该操作会提交到后台执行。'],
      recall: ['撤回消息', '确定撤回这条消息？该操作会提交到后台执行。'],
      recall_mute: ['撤回并禁言', '确定撤回这条消息并禁言发送者？该操作会提交到后台执行。'],
    } as const;
    const [title, body] = labels[action];
    setConfirmation({
      title,
      body,
      confirmLabel: title,
      danger: true,
      action: () => runRecordAction(record, action),
    });
  }

  async function runPreview(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedGroupId) return;
    setPreviewBusy(true);
    setPreviewError('');
    try {
      const response = await api<PreviewResult>(`/api/groups/${encodeURIComponent(selectedGroupId)}/preview`, {
        method: 'POST',
        body: JSON.stringify({ kind: previewKind, text: previewText }),
      });
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setPreviewResult(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setPreviewResult(null);
      setPreviewError(errorText(error));
    } finally {
      setPreviewBusy(false);
    }
  }

  function confirmDialogSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = confirmation;
    setConfirmation(null);
    if (pending) void pending.action();
  }

  if (authState === 'loading') {
    return (
      <div className="boot-screen" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        正在检查登录状态…
      </div>
    );
  }

  if (authState === 'anonymous') {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <div className="brand-mark" aria-hidden="true">FAB</div>
          <h1 id="login-title">QQ 群管理控制台</h1>
          <p>单管理员控制台。QQ 官方凭据只保存在服务器，浏览器不收集密钥。</p>
          {loginError && <div className="alert error" role="alert">{loginError}</div>}
          <form onSubmit={submitLogin}>
            <div className="field">
              <label htmlFor="password">管理密码</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                minLength={1}
              />
            </div>
            <button className="primary" type="submit" disabled={loginBusy}>
              {loginBusy ? '登录中…' : '登录'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const currentWorkspace = workspace ?? (detail ? workspaceFromGroup(detail.group) : null);
  const currentDraft = currentWorkspace?.draft ?? null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span aria-hidden="true">FAB</span>
          <strong>QQ 群管理</strong>
        </div>
        <div className={`connection ${status?.qqConfigured ? 'ready' : 'unknown'}`}>
          <span className="connection-dot" aria-hidden="true" />
          <div>
            <strong>{status?.qqConfigured ? 'QQ 已配置' : 'QQ 未配置'}</strong>
            <span>{status?.qqConfigured ? '凭据在服务端' : '等待服务端接入'}</span>
          </div>
        </div>

        <nav className="group-nav" aria-label="群组">
          <h2>群组</h2>
          {groupsBusy && !groups && <p className="small-loading">加载群组…</p>}
          {groups && groups.length === 0 && <p className="empty-note">还没有群。创建第一个群后开始配置。</p>}
          <ul>
            {(groups ?? []).map(group => (
              <li key={group.id}>
                <button
                  type="button"
                  className={group.id === selectedGroupId ? 'active' : ''}
                  aria-current={group.id === selectedGroupId ? 'true' : undefined}
                  onClick={() => void selectGroup(group.id)}
                  disabled={operationBusy}
                >
                  <span>{group.name}</span>
                  {group.reviewCount > 0 && <b>{group.reviewCount} 待处理</b>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <form className="new-group" onSubmit={createGroup}>
          <h2>新建群</h2>
          <label htmlFor="new-group-id">群 OpenID</label>
          <input
            id="new-group-id"
            value={controlState.newGroupId}
            onChange={event => setControlState(state => ({ ...state, newGroupId: event.target.value }))}
            pattern="[A-Za-z0-9_-]+"
            maxLength={128}
            required
          />
          <label htmlFor="new-group-name">群名称</label>
          <input
            id="new-group-name"
            value={controlState.newGroupName}
            onChange={event => setControlState(state => ({ ...state, newGroupName: event.target.value }))}
            maxLength={100}
            required
          />
          <button type="submit" disabled={groupsBusy || operationBusy}>{groupsBusy ? '处理中…' : '创建群'}</button>
        </form>

        <div className="sidebar-foot">
          <button type="button" className="ghost" onClick={() => void refreshGroups(true)} disabled={groupsBusy}>
            刷新群列表
          </button>
          <button type="button" className="ghost danger" onClick={() => void logout()}>退出登录</button>
        </div>
      </aside>

      <main id="main" className="main">
        <header className="main-header">
          <div>
            <p className="eyebrow">官方 QQ 机器人</p>
            <h1>{selectedGroup ? selectedGroup.name : '群管理'}</h1>
            {selectedGroup && (
              <p className="subtitle">
                OpenID <code>{selectedGroup.id}</code> · 配置修订 {selectedGroup.revision}
                {dirty && <span className="dirty-badge">有未保存修改</span>}
              </p>
            )}
          </div>
          {selectedGroup && (
            <div className="header-actions">
              <button type="button" className="ghost" onClick={() => void loadDetail(selectedGroup.id, true)} disabled={detailBusy}>
                {detailBusy ? '刷新中…' : '刷新本群'}
              </button>
              <button type="button" className="ghost" onClick={() => void pullRequests()} disabled={pullBusy || !status?.qqConfigured}>
                {pullBusy ? '拉取中…' : '拉取入群申请'}
              </button>
            </div>
          )}
        </header>

        {(notice || groupsError || detailError) && (
          <div className="app-messages" aria-live="polite">
            {notice && <div className="alert notice">{notice}</div>}
            {groupsError && <div className="alert error" role="alert">{groupsError}</div>}
            {detailError && <div className="alert error" role="alert">{detailError}</div>}
          </div>
        )}

        {selectedGroupId && (
          <nav className="tabs" aria-label="功能页面">
            {tabs.map(item => (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? 'page' : undefined}
                className={tab === item.id ? 'active' : ''}
                onClick={() => setTab(item.id)}
              >{item.label}</button>
            ))}
          </nav>
        )}

        {!selectedGroupId && (
          <section className="empty-panel" aria-labelledby="no-group-title">
            <h2 id="no-group-title">还没有可管理的群</h2>
            <p>在左侧输入群 OpenID 和群名称创建群。OpenID 来自 QQ 官方群事件，不是 QQ 群号。</p>
          </section>
        )}

        {selectedGroupId && !detail && (detailBusy ? (
          <section className="loading-panel" role="status" aria-live="polite">正在加载群数据…</section>
        ) : !detailError && (
          <section className="empty-panel">暂无群数据。</section>
        ))}

        {detail && currentDraft && tab === 'overview' && (
          <div className="page-grid">
            <section className="panel" aria-labelledby="system-title">
              <h2 id="system-title">服务接入</h2>
              <dl className="facts">
                <div><dt>QQ 接入</dt><dd>{status?.qqConfigured ? '服务端已配置' : '未配置'}</dd></div>
                <div><dt>AppID</dt><dd>{status?.qqConfigured ? textOrDash(status.appId) : '—'}</dd></div>
                <div><dt>事件回调</dt><dd><code>{status?.webhookPath ?? '/qq/events'}</code></dd></div>
                <div><dt>记录保留</dt><dd>{status ? `${status.retentionDays} 天` : '未知'}</dd></div>
              </dl>
              {status?.qqConfigured ? (
                <p className="hint">已配置表示凭据存在；接口权限和线上回调仍需以实际拉取、同步与执行结果为准。</p>
              ) : (
                <div className="setup-guide">
                  <h3>服务端配置步骤</h3>
                  <ol>
                    <li>在服务器 <code>.env</code> 配置 <code>ADMIN_PASSWORD</code>、<code>QQ_APP_ID</code>、<code>QQ_APP_SECRET</code> 和公网 <code>APP_ORIGIN</code>；按需配置 <code>DATABASE_PATH</code>、<code>RETENTION_DAYS</code>。</li>
                    <li>在 QQ 开放平台将事件回调设为 <code>{window.location.origin}/qq/events</code>。</li>
                    <li>重启 FAB 后端，然后重新登录此控制台。</li>
                  </ol>
                  <p>此页面不提供 QQ 密钥输入。</p>
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="state-title">
              <h2 id="state-title">群状态</h2>
              <dl className="facts">
                <div><dt>本群自动化</dt><dd>{detail.group.settings.enabled ? '已启用' : '未启用'}</dd></div>
                <div><dt>审核模式</dt><dd>{detail.group.settings.joinMode === 'auto' ? '自动按规则审核（名单与白名单）' : '人工审核'}</dd></div>
                <div><dt>名单人数</dt><dd>{detail.group.rosterCount}</dd></div>
                <div><dt>待处理记录</dt><dd>{detail.group.reviewCount}</dd></div>
                <div><dt>最近事件</dt><dd>{formatTime(detail.group.lastEventAt)}</dd></div>
                <div><dt>广告治理</dt><dd>{detail.group.settings.moderationEnabled ? ({ observe: '仅记录', recall: '撤回', recall_mute: '撤回并禁言' } as const)[detail.group.settings.moderationMode] : '未启用'}</dd></div>
              </dl>
            </section>

            <section className="panel span-2" aria-labelledby="whitelist-title">
              <h2 id="whitelist-title">QQ 官方白名单</h2>
              {detail.group.whitelistError && (
                <div className="alert warning" role="alert">
                  <strong>同步未完成，旧的官方策略可能仍生效。</strong>
                  <p>{detail.group.whitelistError}</p>
                  <p>请在 QQ 开放平台核对当前策略，处理本地配置后重新同步。</p>
                </div>
              )}
              <dl className="facts">
                <div><dt>官方策略</dt><dd>{detail.group.strategyId ? '已创建' : '未创建'}</dd></div>
                <div><dt>已同步 QQ 数</dt><dd>{detail.group.whitelistSynced.length}</dd></div>
                <div><dt>本地 QQ 白名单</dt><dd>{detail.group.settings.whitelistQQ.length}</dd></div>
              </dl>
              <div className="panel-actions">
                <button type="button" onClick={() => void syncWhitelist()} disabled={whitelistBusy || !status?.qqConfigured}>
                  {whitelistBusy ? '同步中…' : '重新同步官方白名单'}
                </button>
                <button type="button" className="ghost" onClick={() => setTab('admission')}>修改入群配置</button>
              </div>
            </section>
          </div>
        )}

        {detail && currentDraft && (tab === 'admission' || tab === 'moderation') && (
          <form className="settings-layout" onSubmit={saveSettings}>
            <fieldset className="form-body" disabled={settingsBusy} aria-label="群配置">
            {currentWorkspace?.conflict && (
              <div className="alert warning span-all" role="alert">
                <strong>配置版本冲突。</strong>
                <p>服务器配置已变化。为避免覆盖其他修改，已暂停保存；本页草稿仍保留在下方。名单操作引起的修订会自动对齐。</p>
                <button type="button" className="danger" onClick={() => void loadDetail(detail.group.id, false)}>丢弃草稿并载入最新配置</button>
              </div>
            )}
            {settingsError && <div className="alert error span-all" role="alert">{settingsError}</div>}

            {tab === 'admission' ? (
              <>
                <section className="panel" aria-labelledby="group-basic">
                  <h2 id="group-basic">基础与问答</h2>
                  <div className="field">
                    <label htmlFor="group-name">群名称</label>
                    <input id="group-name" value={currentDraft.name} maxLength={100} onChange={event => updateDraft({ name: event.target.value })} />
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={currentDraft.settings.enabled} onChange={event => updateSettings({ enabled: event.target.checked })} />
                    <span>启用本群自动化</span>
                  </label>
                  <fieldset>
                    <legend>审核模式</legend>
                    <label className="radio"><input type="radio" name="join-mode" checked={currentDraft.settings.joinMode === 'review'} onChange={() => updateSettings({ joinMode: 'review' })} /><span>人工审核</span></label>
                    <label className="radio"><input type="radio" name="join-mode" checked={currentDraft.settings.joinMode === 'auto'} onChange={() => updateSettings({ joinMode: 'auto' })} /><span>自动按规则审核（名单与白名单）</span></label>
                  </fieldset>
                  <div className="field-pair">
                    <div className="field">
                      <label htmlFor="name-question">姓名问题标签</label>
                      <input id="name-question" value={currentDraft.settings.nameQuestion} maxLength={100} onChange={event => updateSettings({ nameQuestion: event.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="student-question">学号问题标签</label>
                      <input id="student-question" value={currentDraft.settings.studentQuestion} maxLength={100} onChange={event => updateSettings({ studentQuestion: event.target.value })} />
                    </div>
                  </div>
                  <p className="hint">标签与 QQ 入群问卷中的问题精确匹配；预览页可验证解析结果。</p>
                  <div className="field">
                    <label htmlFor="unmatched">名单未匹配时</label>
                    <select id="unmatched" value={currentDraft.settings.unmatched} onChange={event => updateSettings({ unmatched: event.target.value as Settings['unmatched'] })}>
                      <option value="review">转入人工审核</option>
                      <option value="decline">拒绝</option>
                    </select>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={currentDraft.settings.holdRisky} onChange={event => updateSettings({ holdRisky: event.target.checked })} />
                    <span>有 QQ 风险提示时转人工</span>
                  </label>
                </section>

                <section className="panel" aria-labelledby="qq-whitelist-title">
                  <h2 id="qq-whitelist-title">QQ 号白名单（官方直通）</h2>
                  <div className="alert inline-warning">
                    该名单会同步为 QQ 官方入群策略。命中的申请在 Tencent 侧直接放行，会绕过本服务的问卷解析、风险提示和名单校验。只填可信 QQ 号。
                  </div>
                  <div className="field">
                    <label htmlFor="whitelist-qq">QQ 号，每行一个</label>
                    <textarea id="whitelist-qq" rows={8} value={currentDraft.whitelistQQText} onChange={event => updateDraft({ whitelistQQText: event.target.value })} />
                  </div>
                  <p className="hint">启用本群自动化、选择自动按规则审核且此名单非空时，服务端会创建并启用官方策略。</p>
                </section>

                <section className="panel" aria-labelledby="openid-whitelist-title">
                  <h2 id="openid-whitelist-title">成员 OpenID 白名单</h2>
                  <div className="field">
                    <label htmlFor="whitelist-members">member_openid，每行一个</label>
                    <textarea id="whitelist-members" rows={8} value={currentDraft.whitelistMembersText} onChange={event => updateDraft({ whitelistMembersText: event.target.value })} />
                  </div>
                  <p className="hint">OpenID 来自 QQ 官方事件，不是 QQ 号。它只作用于本服务的入群判断，不同步到 Tencent。</p>
                </section>
              </>
            ) : (
              <section className="panel span-all" aria-labelledby="moderation-title">
                <h2 id="moderation-title">广告治理规则</h2>
                <p className="hint">规则检查消息文本、链接和卡片中的文字；图片与附件只会按设置转入人工复核，不做 OCR 或语义识别。</p>
                {!currentDraft.settings.enabled && <div className="alert warning">本群自动化当前未启用；仅开启广告治理不会自动执行任何动作。</div>}
                <label className="switch">
                  <input type="checkbox" checked={currentDraft.settings.moderationEnabled} onChange={event => updateSettings({ moderationEnabled: event.target.checked })} />
                  <span>启用广告治理</span>
                </label>
                <fieldset>
                  <legend>命中后处理</legend>
                  <label className="radio"><input type="radio" name="moderation-mode" checked={currentDraft.settings.moderationMode === 'observe'} onChange={() => updateSettings({ moderationMode: 'observe' })} /><span>仅记录</span></label>
                  <label className="radio"><input type="radio" name="moderation-mode" checked={currentDraft.settings.moderationMode === 'recall'} onChange={() => updateSettings({ moderationMode: 'recall' })} /><span>撤回</span></label>
                  <label className="radio"><input type="radio" name="moderation-mode" checked={currentDraft.settings.moderationMode === 'recall_mute'} onChange={() => updateSettings({ moderationMode: 'recall_mute' })} /><span>撤回并禁言</span></label>
                </fieldset>
                <div className="field narrow">
                  <label htmlFor="mute-minutes">禁言分钟数</label>
                  <input id="mute-minutes" type="number" min={1} max={43200} step={1} value={currentDraft.muteMinutesText} onChange={event => updateDraft({ muteMinutesText: event.target.value })} />
                </div>
                <label className="switch">
                  <input type="checkbox" checked={currentDraft.settings.reviewMedia} onChange={event => updateSettings({ reviewMedia: event.target.checked })} />
                  <span>图片或附件转入人工复核</span>
                </label>
                <div className="field-pair">
                  <div className="field">
                    <label htmlFor="blocked-phrases">禁止短语，每行一个</label>
                    <textarea id="blocked-phrases" rows={8} value={currentDraft.blockedPhrasesText} onChange={event => updateDraft({ blockedPhrasesText: event.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="blocked-domains">禁止域名，每行一个</label>
                    <textarea id="blocked-domains" rows={8} value={currentDraft.blockedDomainsText} onChange={event => updateDraft({ blockedDomainsText: event.target.value })} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="exempt-members">豁免成员 OpenID，每行一个</label>
                  <textarea id="exempt-members" rows={5} value={currentDraft.exemptMembersText} onChange={event => updateDraft({ exemptMembersText: event.target.value })} />
                </div>
              </section>
            )}

            <div className="save-bar span-all">
              <button className="primary" type="submit" disabled={settingsBusy || Boolean(currentWorkspace?.conflict)}>{settingsBusy ? '保存中…' : '保存本群配置'}</button>
              <span>配置仅作用于本群；QQ 号白名单变更会同步官方策略，结果会单独显示。</span>
            </div>
            </fieldset>
          </form>
        )}

        {detail && tab === 'roster' && currentWorkspace && (
          <div className="roster-layout">
            <section className="panel" aria-labelledby="roster-title">
              <div className="panel-heading">
                <h2 id="roster-title">名单人员</h2>
                <button type="button" onClick={() => setPersonDraft(emptyPersonDraft())} disabled={Boolean(currentWorkspace.person)}>
                  新增人员
                </button>
              </div>
              {personError && <div className="alert error" role="alert">{personError}</div>}
              {currentWorkspace.person && (
                <form className="person-form" onSubmit={savePerson}>
                  <fieldset className="form-body" disabled={personBusy} aria-label="名单人员">
                  <h3>{currentWorkspace.person.id === null ? '新增人员' : `编辑人员 #${currentWorkspace.person.id}`}</h3>
                  <div className="field-pair">
                    <div className="field">
                      <label htmlFor="person-name">姓名</label>
                      <input id="person-name" value={currentWorkspace.person.values.name} maxLength={100} required onChange={event => updatePerson({ name: event.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="person-student-id">学号</label>
                      <input id="person-student-id" value={currentWorkspace.person.values.studentId} maxLength={64} required onChange={event => updatePerson({ studentId: event.target.value })} />
                    </div>
                  </div>
                  <div className="field-pair">
                    <div className="field">
                      <label htmlFor="person-qq">QQ 号（可选）</label>
                      <input id="person-qq" value={currentWorkspace.person.values.qq} inputMode="numeric" onChange={event => updatePerson({ qq: event.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="person-phone">手机号（可选）</label>
                      <input id="person-phone" value={currentWorkspace.person.values.phone} maxLength={32} onChange={event => updatePerson({ phone: event.target.value })} />
                    </div>
                  </div>
                  <div className="panel-actions">
                    <button className="primary" type="submit" disabled={personBusy}>{personBusy ? '保存中…' : '保存人员'}</button>
                    <button className="ghost" type="button" onClick={() => setPersonDraft(null)} disabled={personBusy}>取消</button>
                  </div>
                  </fieldset>
                </form>
              )}

              {detail.roster.length === 0 ? (
                <p className="empty-note">本群还没有名单人员。可单人新增，或使用下方 CSV 导入。</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <caption className="sr-only">本群名单人员</caption>
                    <thead>
                      <tr><th scope="col">姓名</th><th scope="col">学号</th><th scope="col">QQ 号</th><th scope="col">手机号</th><th scope="col">成员 OpenID</th><th scope="col">操作</th></tr>
                    </thead>
                    <tbody>
                      {detail.roster.map(person => (
                        <tr key={person.id}>
                          <td>{person.name}</td>
                          <td>{person.studentId}</td>
                          <td>{textOrDash(person.qq)}</td>
                          <td>{textOrDash(person.phone)}</td>
                          <td><code>{textOrDash(person.memberOpenid)}</code></td>
                          <td>
                            <div className="row-actions">
                              <button type="button" onClick={() => setPersonDraft({ id: person.id, values: personValues(person) })}>编辑</button>
                              <button type="button" className="danger" onClick={() => askDeletePerson(person)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="hint">名单用于核对入群答案；不会自动修改群昵称，自动昵称编辑暂缓。</p>
            </section>

            <section className="panel" aria-labelledby="import-title">
              <h2 id="import-title">CSV 导入</h2>
              <p className="hint">表头必须精确为：<code>姓名,学号,QQ号,手机号</code>。值为字符串，QQ 号和手机号可留空。</p>
              <div className="field">
                <label htmlFor="roster-csv">CSV 内容</label>
                <textarea id="roster-csv" rows={9} value={currentWorkspace.csv} onChange={event => setCsv(event.target.value)} spellCheck={false} readOnly={importBusy} />
              </div>
              {importError && <div className="alert error" role="alert">{importError}</div>}
              <div className="panel-actions">
                <button type="button" onClick={() => void previewImport()} disabled={importBusy || !currentWorkspace.csv.trim()}>
                  {importBusy ? '处理中…' : '预检 CSV'}
                </button>
                <button type="button" className="primary" onClick={() => void commitImport()} disabled={importBusy || !importPreview}>
                  提交导入
                </button>
              </div>
              {importPreview && (
                <div className="import-preview">
                  <h3>预检通过 {importPreview.count} 人</h3>
                  <p className="hint">预检不会写入。提交会原子添加以下全部人员。</p>
                  <div className="table-wrap">
                    <table>
                      <caption className="sr-only">CSV 导入预检结果</caption>
                      <thead><tr><th scope="col">姓名</th><th scope="col">学号</th><th scope="col">QQ 号</th><th scope="col">手机号</th></tr></thead>
                      <tbody>
                        {importPreview.people.map((person, index) => (
                          <tr key={`${person.studentId}-${index}`}>
                            <td>{person.name}</td><td>{person.studentId}</td><td>{textOrDash(person.qq)}</td><td>{textOrDash(person.phone)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {detail && tab === 'review' && (
          <section className="panel review-panel" aria-labelledby="review-title">
            <div className="panel-heading">
              <h2 id="review-title">记录与处理</h2>
              <label className="select-label">
                筛选
                <select value={recordFilter} onChange={event => setRecordFilter(event.target.value as typeof recordFilter)}>
                  <option value="pending">待处理</option>
                  <option value="outcome">已有结果</option>
                  <option value="all">全部</option>
                </select>
              </label>
            </div>
            {recordError && <div className="alert error" role="alert">{recordError}</div>}
            {pendingSignature && <div className="alert notice">有操作排队或执行中；本页可见时最多轮询记录约 1 分钟。</div>}
            <ul className="record-list">
              {detail.records
                .filter(record => {
                  if (recordFilter === 'pending') return ['review', 'queued', 'processing', 'failed', 'observed', 'expired'].includes(record.status);
                  if (recordFilter === 'outcome') return ['succeeded', 'failed', 'ignored', 'expired'].includes(record.status);
                  return true;
                })
                .map(record => {
                  const actionable = ['review', 'failed', 'observed', 'expired'].includes(record.status);
                  const busyKey = `${record.id}:`;
                  return (
                    <li key={record.id} className={`record status-${record.status}`}>
                      <div className="record-head">
                        <strong>{record.kind === 'join' ? '入群申请' : '消息'}</strong>
                        <span className={`status status-${record.status}`}>{statusLabels[record.status] ?? record.status}</span>
                        <time dateTime={new Date(record.occurredAt).toISOString()}>{formatDateTime(record.occurredAt)}</time>
                      </div>
                      <dl className="record-facts">
                        <div><dt>发送者</dt><dd>{textOrDash(record.username)} · <code>{record.memberOpenid}</code></dd></div>
                        <div><dt>判断</dt><dd>{decisionLabels[record.decision] ?? record.decision}</dd></div>
                        <div><dt>原因</dt><dd>{record.reason || '—'}</dd></div>
                        <div><dt>结果</dt><dd>{record.outcome || (record.status === 'queued' ? '等待后台执行' : record.status === 'processing' ? '正在执行' : '暂无')}</dd></div>
                        {record.error && <div className="error-outcome"><dt>错误</dt><dd>{record.error}</dd></div>}
                      </dl>
                      <div className="record-content"><dt className="sr-only">内容</dt><dd>{record.content || '（无文本内容；可能为图片或附件）'}</dd></div>
                      {actionable && (
                        <div className="row-actions">
                          {record.kind === 'join' ? (
                            <>
                              <button type="button" className="primary" disabled={Boolean(actionBusy?.startsWith(busyKey))} onClick={() => void runRecordAction(record, 'approve')}>通过</button>
                              <button type="button" className="danger" disabled={Boolean(actionBusy?.startsWith(busyKey))} onClick={() => askRecordAction(record, 'decline')}>拒绝</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="danger" disabled={Boolean(actionBusy?.startsWith(busyKey))} onClick={() => askRecordAction(record, 'recall')}>撤回</button>
                              <button type="button" className="danger" disabled={Boolean(actionBusy?.startsWith(busyKey))} onClick={() => askRecordAction(record, 'recall_mute')}>撤回并禁言</button>
                            </>
                          )}
                          <button type="button" className="ghost" disabled={Boolean(actionBusy?.startsWith(busyKey))} onClick={() => void runRecordAction(record, 'ignore')}>忽略</button>
                          {actionBusy?.startsWith(busyKey) && <span aria-live="polite">提交中…</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
            {detail.records.length === 0 && <p className="empty-note">暂无记录。可在总览拉取入群申请，或等待事件回调。</p>}
            {detail.records.length > 0 && filteredRecordCount(detail.records, recordFilter) === 0 && <p className="empty-note">当前筛选没有记录。</p>}
            {hasMoreRecords && (
              <button type="button" className="ghost" onClick={() => void loadOlderRecords()} disabled={recordsBusy}>
                {recordsBusy ? '加载中…' : '载入更早记录'}
              </button>
            )}
          </section>
        )}

        {detail && tab === 'preview' && (
          <section className="panel preview-panel" aria-labelledby="preview-title">
            <h2 id="preview-title">规则预览</h2>
            <p className="hint">预览只读取当前已保存规则，不会修改记录或群状态；未保存草稿不会参与判定。</p>
            {previewKind === 'message' && <p className="hint">当前执行模式：{!detail.group.settings.enabled || !detail.group.settings.moderationEnabled ? '自动处理已关闭' : detail.group.settings.moderationMode === 'observe' ? '仅记录，不自动撤回' : detail.group.settings.moderationMode === 'recall' ? '自动撤回' : '撤回并禁言'}。下方显示规则判定，不代表已执行。</p>}
            {dirty && <div className="alert warning" role="status">当前设置有未保存修改。请先保存本群配置，再运行预览。</div>}
            <form onSubmit={runPreview}>
              <div className="field">
                <label htmlFor="preview-kind">预览类型</label>
                <select id="preview-kind" value={previewKind} disabled={previewBusy} onChange={event => { setPreviewKind(event.target.value as 'join' | 'message'); setPreviewResult(null); }}>
                  <option value="join">入群答案</option>
                  <option value="message">消息文本</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="preview-text">{previewKind === 'join' ? '入群答案文本' : '消息文本'}</label>
                <textarea
                  id="preview-text"
                  rows={9}
                  readOnly={previewBusy}
                  value={previewText}
                  onChange={event => { setPreviewText(event.target.value); setPreviewResult(null); }}
                  placeholder={previewKind === 'join' ? '姓名：张三\n学号：20260001' : '需要检查的文本、链接或卡片文字'}
                />
              </div>
              {previewKind === 'join' && <p className="hint">每行一条「问题标签:答案」，标签与入群配置一致。</p>}
              <button className="primary" type="submit" disabled={previewBusy || dirty}>{previewBusy ? '预览中…' : '运行已保存规则预览'}</button>
            </form>
            {previewError && <div className="alert error" role="alert">{previewError}</div>}
            {previewResult && (
              <dl className="preview-result">
                <div><dt>判定</dt><dd>{decisionLabels[previewResult.decision] ?? previewResult.decision}</dd></div>
                <div><dt>原因</dt><dd>{previewResult.reason}</dd></div>
                {previewResult.personId !== undefined && <div><dt>匹配人员</dt><dd>#{previewResult.personId}</dd></div>}
              </dl>
            )}
          </section>
        )}
      </main>

      <dialog ref={confirmDialog} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={() => setConfirmation(null)}>
        {confirmation && (
          <form method="dialog" onSubmit={confirmDialogSubmit}>
            <h2 id="confirm-title">{confirmation.title}</h2>
            <p>{confirmation.body}</p>
            <div className="dialog-actions">
              <button type="button" className="ghost" onClick={() => setConfirmation(null)}>取消</button>
              <button type="submit" className={confirmation.danger ? 'danger' : 'primary'}>{confirmation.confirmLabel}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

function filteredRecordCount(records: RecordItem[], filter: 'pending' | 'all' | 'outcome') {
  return records.filter(record => {
    if (filter === 'pending') return ['review', 'queued', 'processing', 'failed', 'observed', 'expired'].includes(record.status);
    if (filter === 'outcome') return ['succeeded', 'failed', 'ignored', 'expired'].includes(record.status);
    return true;
  }).length;
}
