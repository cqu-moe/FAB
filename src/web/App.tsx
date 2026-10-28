import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  AppShell,
  Button,
  ContentContainer,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  ThemeMenu,
} from "@cqu-moe/ui";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  FlaskConical,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { ApiError, api } from "./api";
import {
  formatDateTime,
  formatTime,
  linesToText,
  sameLines,
  textOrDash,
  textToLines,
} from "./helpers";
import {
  type Group,
  type GroupDetail,
  type Person,
  type PersonInput,
  type PreviewResult,
  type RecordItem,
  type Settings,
  type SystemStatus,
} from "../shared";

type SessionResponse = { authenticated: true; status: SystemStatus };
type GroupsResponse = { groups: Group[]; status: SystemStatus };
type GroupMutationResponse = { group: Group };
type RecordsResponse = { records: RecordItem[] };
type CountResponse = { count: number };
type OkResponse = { ok: true };
type ImportResponse = { people: PersonInput[]; count: number };

type Tab =
  "overview" | "admission" | "roster" | "moderation" | "review" | "preview";
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
type Workspace = {
  draft: GroupDraft;
  person: PersonDraft | null;
  csv: string;
  conflict: boolean;
};
type ControlState = {
  selectedGroupId: string | null;
  newGroupId: string;
  newGroupName: string;
  workspaces: Record<string, Workspace>;
};
type Confirmation = {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  action: () => void | Promise<void>;
};

const legacyStorageKey = "fab-qq-control-v1";
const emptyControlState: ControlState = {
  selectedGroupId: null,
  newGroupId: "",
  newGroupName: "",
  workspaces: {},
};
const emptyPerson: PersonInput = { name: "", studentId: "", qq: "", phone: "" };

const tabs = [
  {
    id: "overview",
    label: "群组概览",
    icon: LayoutDashboard,
    description: "查看群组状态与待办，安排接下来的管理工作。",
  },
  {
    id: "review",
    label: "审核记录",
    icon: ClipboardCheck,
    description: "核对入群申请与消息，跟进每一条处理结果。",
  },
  {
    id: "roster",
    label: "成员名单",
    icon: Users,
    description: "维护本群的入群核对名单，支持单人录入与批量导入。",
  },
  {
    id: "admission",
    label: "入群审核",
    icon: ShieldCheck,
    description: "设置问答匹配、风险处理与白名单。",
  },
  {
    id: "moderation",
    label: "广告处理",
    icon: MessageSquare,
    description: "配置消息规则，以及命中规则后的处理方式。",
  },
  {
    id: "preview",
    label: "规则测试",
    icon: FlaskConical,
    description: "用一段内容检查已保存的规则，不会执行真实操作。",
  },
] as const;

const decisionLabels: Record<string, string> = {
  approve: "通过",
  decline: "拒绝",
  recall: "撤回",
  recall_mute: "撤回并禁言",
  review: "人工审核",
  ignore: "忽略",
};

const statusLabels: Record<string, string> = {
  review: "待审核",
  queued: "已排队",
  processing: "执行中",
  succeeded: "已成功",
  failed: "执行失败",
  observed: "待复核",
  ignored: "已忽略",
  expired: "已过期",
};

const emptyPersonDraft = (): PersonDraft => ({
  id: null,
  values: { ...emptyPerson },
});

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
  csv: "",
  conflict: false,
});

const sameSettings = (left: Settings, right: Settings) =>
  JSON.stringify(left) === JSON.stringify(right);

const draftHasEdits = (
  draft: GroupDraft,
  group: Pick<Group, "name" | "settings">,
) =>
  draft.name.trim() !== group.name ||
  !sameSettings(draft.settings, group.settings) ||
  !sameLines(draft.whitelistQQText, group.settings.whitelistQQ) ||
  !sameLines(draft.whitelistMembersText, group.settings.whitelistMembers) ||
  !sameLines(draft.blockedPhrasesText, group.settings.blockedPhrases) ||
  !sameLines(draft.blockedDomainsText, group.settings.blockedDomains) ||
  !sameLines(draft.exemptMembersText, group.settings.exemptMembers) ||
  draft.muteMinutesText.trim() !== String(group.settings.muteMinutes);

export function refreshWorkspace(
  previous: Workspace | undefined,
  group: Group,
  preserve: boolean,
): Workspace {
  if (!preserve || !previous) return workspaceFromGroup(group);
  const edited = draftHasEdits(previous.draft, {
    name: previous.draft.baseName,
    settings: previous.draft.baseSettings,
  });
  const conflict =
    edited &&
    (previous.draft.baseName !== group.name ||
      !sameSettings(previous.draft.baseSettings, group.settings));
  return {
    ...previous,
    draft: edited
      ? { ...previous.draft, revision: group.revision }
      : draftFromGroup(group),
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
    blockedDomains: textToLines(draft.blockedDomainsText).map((value) =>
      value.toLowerCase(),
    ),
    exemptMembers: textToLines(draft.exemptMembersText),
  };
};

const isValidDraft = (draft: GroupDraft): string | null => {
  if (!draft.name.trim()) return "群名称不能为空";
  if (!draft.settings.nameQuestion.trim()) return "姓名标签不能为空";
  if (!draft.settings.studentQuestion.trim()) return "学号标签不能为空";
  if (
    draft.settings.nameQuestion.trim() === draft.settings.studentQuestion.trim()
  )
    return "姓名和学号的问题标签不能相同";
  if (
    !Number.isInteger(Number(draft.muteMinutesText.trim())) ||
    Number(draft.muteMinutesText.trim()) < 1 ||
    Number(draft.muteMinutesText.trim()) > 43200
  ) {
    return "禁言时长须为 1–43200 的整数分钟";
  }
  if (
    textToLines(draft.whitelistQQText).some(
      (value) => !/^[1-9][0-9]{4,19}$/.test(value),
    )
  )
    return "QQ 白名单中有格式不正确的 QQ 号";
  if (
    textToLines(draft.blockedDomainsText).some(
      (value) =>
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value),
    )
  ) {
    return "禁止域名须为小写裸域名，不含协议或路径";
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
  return "请求失败，请稍后重试";
};

export default function App() {
  const [authState, setAuthState] = useState<"loading" | "anonymous" | "ready">(
    "loading",
  );
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [hasMoreRecords, setHasMoreRecords] = useState(false);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState<
    "pending" | "all" | "outcome"
  >("pending");

  const [tab, setTab] = useState<Tab>("overview");
  const [controlState, setControlState] =
    useState<ControlState>(emptyControlState);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [notice, setNotice] = useState("");
  const [whitelistBusy, setWhitelistBusy] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState("");
  const [importPreview, setImportPreview] = useState<ImportResponse | null>(
    null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [previewKind, setPreviewKind] = useState<"join" | "message">("join");
  const [previewText, setPreviewText] = useState("");
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(
    null,
  );
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rosterSearch, setRosterSearch] = useState("");
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const recordPollCount = useRef(0);
  const selectedGroupIdRef = useRef<string | null>(null);
  const detailGenerationRef = useRef(0);
  const selectedGroup =
    detail?.group ??
    groups?.find((group) => group.id === selectedGroupId) ??
    null;
  const workspace = selectedGroupId
    ? (controlState.workspaces[selectedGroupId] ??
      (detail ? workspaceFromGroup(detail.group) : null))
    : null;
  const draft = workspace?.draft ?? null;
  const dirty = Boolean(detail && draft && draftHasEdits(draft, detail.group));
  const operationBusy =
    settingsBusy ||
    personBusy ||
    importBusy ||
    previewBusy ||
    whitelistBusy ||
    pullBusy ||
    Boolean(actionBusy);
  selectedGroupIdRef.current = selectedGroupId;

  useEffect(() => {
    try {
      localStorage.removeItem(legacyStorageKey);
    } catch {
      // Cleanup is best-effort when a browser blocks storage access.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const session = await api<SessionResponse>("/api/session");
        if (cancelled) return;
        setStatus(session.status);
        setAuthState("ready");
        void loadGroups(true, session.status);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthState("anonymous");
          return;
        }
        setLoginError(errorText(error));
        setAuthState("anonymous");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      authState !== "ready" ||
      !selectedGroupId ||
      detail?.group.id === selectedGroupId
    )
      return;
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
    if (authState !== "ready") return;
    const timer = window.setInterval(() => {
      if (document.hidden || activeEditing) return;
      void refreshGroups(false);
      if (selectedGroupId) void loadDetail(selectedGroupId, false);
    }, 30000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, activeEditing, selectedGroupId]);

  const pendingSignature = useMemo(
    () =>
      (detail?.records ?? [])
        .filter(
          (record) =>
            record.status === "queued" || record.status === "processing",
        )
        .map((record) => `${record.id}:${record.status}`)
        .join(","),
    [detail?.records],
  );

  useEffect(() => {
    if (tab !== "review" || !pendingSignature || !selectedGroupId) return;
    const timer = window.setInterval(() => {
      if (document.hidden || recordPollCount.current >= 20) return;
      recordPollCount.current += 1;
      void api<RecordsResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/records`,
      )
        .then((response) => {
          if (selectedGroupIdRef.current !== selectedGroupId) return;
          setDetail((current) => {
            if (!current || current.group.id !== selectedGroupId)
              return current;
            const old = current.records.filter(
              (record) =>
                !response.records.some((item) => item.id === record.id),
            );
            return { ...current, records: [...response.records, ...old] };
          });
        })
        .catch((error) => setRecordError(errorText(error)));
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedGroupId, pendingSignature]);

  useEffect(() => {
    recordPollCount.current = 0;
  }, [tab, selectedGroupId]);

  async function loadGroups(initial = false, knownStatus?: SystemStatus) {
    setGroupsError("");
    if (initial) setGroupsBusy(true);
    try {
      const response = await api<GroupsResponse>("/api/groups");
      setGroups(response.groups);
      setStatus(knownStatus ?? response.status);
      setSelectedGroupId((current) => {
        if (current && response.groups.some((group) => group.id === current))
          return current;
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
    setDetailError("");
    setDetailBusy(true);
    try {
      const response = await api<GroupDetail>(
        `/api/groups/${encodeURIComponent(groupId)}`,
      );
      if (
        selectedGroupIdRef.current !== groupId ||
        detailGenerationRef.current !== generation
      )
        return;
      setDetail(response);
      setControlState((state) => ({
        ...state,
        workspaces: {
          ...state.workspaces,
          [groupId]: refreshWorkspace(
            state.workspaces[groupId],
            response.group,
            preserveDraft,
          ),
        },
      }));
      setHasMoreRecords(response.records.length === 100);
      setRecordError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      setDetailError(errorText(error));
    } finally {
      if (
        selectedGroupIdRef.current === groupId &&
        detailGenerationRef.current === generation
      )
        setDetailBusy(false);
    }
  }

  function resetSession() {
    setAuthState("anonymous");
    selectedGroupIdRef.current = null;
    detailGenerationRef.current += 1;
    setStatus(null);
    setGroups(null);
    setSelectedGroupId(null);
    setDetail(null);
    setPassword("");
    setNotice("");
    setControlState(emptyControlState);
    setImportPreview(null);
    setImportError("");
    setPersonError("");
    setPreviewText("");
    setPreviewResult(null);
    setPreviewError("");
    setRecordError("");
    setConfirmation(null);
    setCreateOpen(false);
    setImportOpen(false);
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const response = await api<SessionResponse>("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setStatus(response.status);
      setAuthState("ready");
      setPassword("");
      await loadGroups(true, response.status);
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    try {
      await api<OkResponse>("/api/logout", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (error) {
      resetSession();
      setLoginError(`退出请求失败，服务端会话可能仍有效：${errorText(error)}`);
      return;
    }
    resetSession();
  }

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    if (groupsBusy || operationBusy) return;
    const id = controlState.newGroupId.trim();
    const name = controlState.newGroupName.trim();
    if (!id || !name) {
      setGroupsError("群 OpenID 和群名称都不能为空");
      return;
    }
    setGroupsBusy(true);
    setGroupsError("");
    try {
      await api<GroupMutationResponse>("/api/groups", {
        method: "POST",
        body: JSON.stringify({ id, name }),
      });
      setControlState((state) => ({
        ...state,
        newGroupId: "",
        newGroupName: "",
      }));
      setCreateOpen(false);
      setNotice("群已添加，请继续配置入群规则。");
      await loadGroups(false);
      await selectGroup(id);
      setTab("admission");
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
    setDetailError("");
    setRecordError("");
    setSettingsError("");
    setPersonError("");
    setImportError("");
    setNotice("");
    setImportPreview(null);
    setTab("overview");
    setRosterSearch("");
    setPreviewText("");
    setPreviewResult(null);
    setPreviewError("");
    setControlState((state) => ({ ...state, selectedGroupId: groupId }));
    await loadDetail(groupId, true);
  }

  function updateDraft(patch: Partial<GroupDraft>) {
    if (!selectedGroupId || !draft) return;
    setSettingsError("");
    setControlState((state) => {
      const current =
        state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: {
            ...current,
            draft: { ...current.draft, ...patch },
          },
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
    setPersonError("");
    setControlState((state) => {
      const current = state.workspaces[selectedGroupId];
      if (!current?.person) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: {
            ...current,
            person: {
              ...current.person,
              values: { ...current.person.values, ...patch },
            },
          },
        },
      };
    });
  }

  function setPersonDraft(personDraft: PersonDraft | null) {
    if (!selectedGroupId) return;
    setControlState((state) => {
      const current =
        state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: { ...current, person: personDraft },
        },
      };
    });
  }

  function setCsv(csv: string) {
    if (!selectedGroupId) return;
    setImportPreview(null);
    setImportError("");
    setControlState((state) => {
      const current =
        state.workspaces[selectedGroupId] ?? workspaceFromGroup(detail!.group);
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: { ...current, csv },
        },
      };
    });
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (
      settingsBusy ||
      !selectedGroupId ||
      !draft ||
      !detail ||
      workspace?.conflict
    )
      return;
    const invalid = isValidDraft(draft);
    if (invalid) {
      setSettingsError(invalid);
      return;
    }
    setSettingsBusy(true);
    setSettingsError("");
    setNotice("");
    try {
      const settings = parsedSettings(draft);
      const response = await api<GroupMutationResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: draft.name.trim(),
            settings,
            revision: draft.revision,
          }),
        },
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setDetail((current) =>
        current?.group.id === selectedGroupId
          ? { ...current, group: response.group }
          : current,
      );
      setControlState((state) => ({
        ...state,
        workspaces: {
          ...state.workspaces,
          [selectedGroupId]: {
            ...(state.workspaces[selectedGroupId] ??
              workspaceFromGroup(response.group)),
            draft: draftFromGroup(response.group),
            conflict: false,
          },
        },
      }));
      setNotice(
        response.group.whitelistError
          ? "本地配置已保存，但 QQ 官方白名单同步未完成。"
          : "本地配置已保存。",
      );
      await loadDetail(selectedGroupId, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        resetSession();
        return;
      }
      const message = errorText(error);
      setSettingsError(message);
      if (error instanceof ApiError && error.status === 409) {
        setControlState((state) => {
          const current = state.workspaces[selectedGroupId];
          if (!current) return state;
          return {
            ...state,
            workspaces: {
              ...state.workspaces,
              [selectedGroupId]: { ...current, conflict: true },
            },
          };
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
    setNotice("");
    try {
      await api<OkResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/whitelist/sync`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice("QQ 官方白名单同步已由服务端确认成功。");
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
    setNotice("");
    try {
      const response = await api<CountResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/requests/pull`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice(
        response.count === 0
          ? "没有新增入群申请，已有记录已自动去重。"
          : `新增 ${response.count} 条入群申请，已有记录已自动去重。`,
      );
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
    if (personBusy || !selectedGroupId || !workspace?.person || !detail) return;
    const person = workspace.person;
    if (!person.values.name.trim() || !person.values.studentId.trim()) {
      setPersonError("姓名和学号都不能为空");
      return;
    }
    setPersonBusy(true);
    setPersonError("");
    try {
      const path =
        person.id === null
          ? `/api/groups/${encodeURIComponent(selectedGroupId)}/roster`
          : `/api/groups/${encodeURIComponent(selectedGroupId)}/roster/${person.id}`;
      if (person.id === null) {
        await api<CountResponse>(path, {
          method: "POST",
          body: JSON.stringify({ people: [person.values] }),
        });
      } else {
        await api<OkResponse>(path, {
          method: "PUT",
          body: JSON.stringify(person.values),
        });
      }
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setPersonDraft(null);
      setNotice(person.id === null ? "已添加名单人员。" : "已保存名单人员。");
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

  function askConfirmation(value: Confirmation) {
    confirmationTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setConfirmation(value);
  }

  function askDeletePerson(person: Person) {
    askConfirmation({
      title: "删除名单人员",
      body: `确定删除「${person.name}（${person.studentId}）」？此操作会立即保存。`,
      confirmLabel: "删除人员",
      danger: true,
      action: async () => {
        if (!selectedGroupId) return;
        setPersonBusy(true);
        setPersonError("");
        try {
          await api<OkResponse>(
            `/api/groups/${encodeURIComponent(selectedGroupId)}/roster/${person.id}`,
            { method: "DELETE" },
          );
          if (selectedGroupIdRef.current !== selectedGroupId) return;
          if (workspace?.person?.id === person.id) setPersonDraft(null);
          setNotice("已删除名单人员。");
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
    setImportError("");
    try {
      const response = await api<ImportResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/roster/import`,
        {
          method: "POST",
          body: JSON.stringify({ csv: workspace.csv, commit: false }),
        },
      );
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
    setImportError("");
    try {
      await api<ImportResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/roster/import`,
        {
          method: "POST",
          body: JSON.stringify({ csv: workspace.csv, commit: true }),
        },
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setImportPreview(null);
      setCsv("");
      setImportOpen(false);
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
    setRecordError("");
    try {
      const response = await api<RecordsResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/records?before=${before}`,
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setDetail((current) => {
        if (!current || current.group.id !== selectedGroupId) return current;
        const known = new Set(current.records.map((record) => record.id));
        return {
          ...current,
          records: [
            ...current.records,
            ...response.records.filter((record) => !known.has(record.id)),
          ],
        };
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

  async function runRecordAction(
    record: RecordItem,
    action: "approve" | "decline" | "ignore" | "recall" | "recall_mute",
  ) {
    if (!selectedGroupId) return;
    const key = `${record.id}:${action}`;
    setActionBusy(key);
    setRecordError("");
    setNotice("");
    recordPollCount.current = 0;
    try {
      await api<OkResponse>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/records/${record.id}/action`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      if (selectedGroupIdRef.current !== selectedGroupId) return;
      setNotice("操作已提交到后台队列，请等待执行结果。");
      await loadDetail(selectedGroupId, true);
      await loadGroups(false);
      setTab("review");
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

  function askRecordAction(
    record: RecordItem,
    action: "decline" | "recall" | "recall_mute",
  ) {
    const labels = {
      decline: ["拒绝入群", "确定拒绝这条入群申请？该操作会提交到后台执行。"],
      recall: ["撤回消息", "确定撤回这条消息？该操作会提交到后台执行。"],
      recall_mute: [
        "撤回并禁言",
        "确定撤回这条消息并禁言发送者？该操作会提交到后台执行。",
      ],
    } as const;
    const [title, body] = labels[action];
    askConfirmation({
      title,
      body,
      confirmLabel: title,
      danger: true,
      action: () => runRecordAction(record, action),
    });
  }

  async function runPreview(event: React.FormEvent) {
    event.preventDefault();
    if (previewBusy || dirty || !selectedGroupId) return;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const response = await api<PreviewResult>(
        `/api/groups/${encodeURIComponent(selectedGroupId)}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ kind: previewKind, text: previewText }),
        },
      );
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

  if (authState !== "ready") {
    return (
      <div className="auth-page">
        <header className="auth-header">
          <a className="brand" href="/" aria-label="FAB 首页">
            <ShieldCheck size={24} aria-hidden="true" />
            <span>FAB</span>
            <span className="brand-caption">QQ 群管理</span>
          </a>
          <ThemeMenu />
        </header>
        <main className="auth-main">
          {authState === "loading" ? (
            <PageState
              state="loading"
              title="正在进入控制台"
              description="检查登录状态…"
            />
          ) : (
            <section className="auth-content" aria-labelledby="login-title">
              <div className="auth-intro">
                <span className="eyebrow">群管理，从容有序</span>
                <h1 id="login-title">欢迎回来。</h1>
                <p>
                  从入群到日常交流，
                  <br />
                  在一个工作台照看好每个群。
                </p>
              </div>
              <form className="auth-form" onSubmit={submitLogin}>
                <div className="field">
                  <Label htmlFor="password">管理密码</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setLoginError("");
                    }}
                    autoComplete="current-password"
                    placeholder="输入管理密码"
                    required
                    disabled={loginBusy}
                    aria-invalid={Boolean(loginError)}
                    aria-describedby={loginError ? "login-error" : undefined}
                  />
                  {loginError && (
                    <p className="field-error" id="login-error" role="alert">
                      {loginError}
                    </p>
                  )}
                </div>
                <ActionButton
                  type="submit"
                  state={loginBusy ? "loading" : loginError ? "error" : "idle"}
                  labels={{
                    idle: "进入控制台",
                    loading: "正在登录…",
                    success: "已登录",
                    error: "重新登录",
                  }}
                />
              </form>
              <p className="auth-note">
                <LockKeyhole size={16} aria-hidden="true" />
                仅管理员可访问 · 群数据独立管理
              </p>
              <div className="auth-features" aria-label="主要功能">
                <span>入群审核</span>
                <span>广告处理</span>
                <span>每群独立配置</span>
              </div>
            </section>
          )}
        </main>
        <footer className="auth-footer">
          <span>FAB · 官方 QQ Bot 管理工具</span>
          <span>让管理回归简单</span>
        </footer>
      </div>
    );
  }

  const currentWorkspace =
    workspace ?? (detail ? workspaceFromGroup(detail.group) : null);
  const currentDraft = currentWorkspace?.draft ?? null;

  const search = rosterSearch.trim().toLowerCase();
  const visibleRoster = (detail?.roster ?? []).filter(
    (person) =>
      !search ||
      [person.name, person.studentId, person.qq].some((value) =>
        value.toLowerCase().includes(search),
      ),
  );
  const visibleRecords = (detail?.records ?? []).filter((record) => {
    if (recordFilter === "pending")
      return [
        "review",
        "queued",
        "processing",
        "failed",
        "observed",
        "expired",
      ].includes(record.status);
    if (recordFilter === "outcome")
      return ["succeeded", "failed", "ignored", "expired"].includes(
        record.status,
      );
    return true;
  });
  const activeTab = tabs.find((item) => item.id === tab)!;
  const nav = (
    <>
      <p className="nav-caption">工作空间</p>
      {tabs.map(({ id, label, icon: Icon }, index) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={tab === id ? "page" : undefined}
          className={index === 3 ? "nav-section-start" : undefined}
          onClick={(event) => {
            event.preventDefault();
            setTab(id);
          }}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
          {id === "review" && Boolean(selectedGroup?.reviewCount) && (
            <span className="nav-count">{selectedGroup?.reviewCount}</span>
          )}
        </a>
      ))}
      <div className="nav-foot">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>
          官方 QQ Bot
          <br />
          <small>
            {status?.qqConfigured ? "服务端凭据已配置" : "等待连接 QQ"}
          </small>
        </span>
      </div>
    </>
  );

  return (
    <AppShell
      brand={
        <a className="brand" href="/" aria-label="FAB 首页">
          <ShieldCheck size={24} aria-hidden="true" />
          <span>FAB</span>
          <span className="brand-caption">QQ 群管理</span>
        </a>
      }
      navigation={nav}
      utilities={
        <>
          <ThemeMenu />
          <Button
            variant="ghost"
            size="icon"
            aria-label="退出登录"
            onClick={() => void logout()}
            disabled={operationBusy}
          >
            <LogOut aria-hidden="true" />
          </Button>
        </>
      }
    >
      <ContentContainer width="standard">
        <div className="workspace-bar">
          <div className="workspace-switch">
            <Select
              value={selectedGroupId ?? undefined}
              onValueChange={(value) => void selectGroup(value)}
              disabled={operationBusy || !groups?.length}
            >
              <SelectTrigger aria-label="切换群组">
                <Users size={16} aria-hidden="true" />
                <SelectValue placeholder="选择群组" />
              </SelectTrigger>
              <SelectContent>
                {(groups ?? []).map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              id="add-group"
              aria-label="添加群组"
              onClick={() => setCreateOpen(true)}
              disabled={operationBusy}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <span className="workspace-caption">
            {dirty
              ? "有未保存的修改"
              : selectedGroup
                ? "本群独立配置"
                : "你的群组工作空间"}
          </span>
        </div>
        <PageHeader
          title={selectedGroupId ? activeTab.label : "群组工作台"}
          description={
            selectedGroupId
              ? activeTab.description
              : "连接一个群，开始配置专属的管理规则。"
          }
          actions={
            selectedGroup && (
              <Button
                variant="outline"
                onClick={() => void loadDetail(selectedGroup.id, true)}
                disabled={detailBusy || operationBusy}
              >
                <RefreshCw aria-hidden="true" />
                {detailBusy ? "刷新中…" : "刷新"}
              </Button>
            )
          }
        />
        {notice && (
          <Alert className="page-message">
            <AlertDescription>
              <div className="notice-row">
                <span>{notice}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="关闭提示"
                  onClick={() => setNotice("")}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {groupsError && !createOpen && (
          <Alert variant="destructive" className="page-message">
            <AlertTitle>群列表加载失败</AlertTitle>
            <AlertDescription>
              <div className="notice-row">
                <span>{groupsError}</span>
                <Button
                  variant="outline"
                  onClick={() => void refreshGroups()}
                  disabled={groupsBusy}
                >
                  重试
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {detailError && (
          <Alert variant="destructive" className="page-message">
            <AlertTitle>群数据加载失败</AlertTitle>
            <AlertDescription>
              <div className="notice-row">
                <span>{detailError}</span>
                <Button
                  variant="outline"
                  onClick={() =>
                    selectedGroupId && void loadDetail(selectedGroupId, true)
                  }
                >
                  重新加载
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {!selectedGroupId &&
          (groupsBusy ? (
            <PageState
              state="loading"
              title="正在读取群组"
              description="请稍候…"
            />
          ) : (
            groups !== null && (
              <div className="empty-workspace">
                <PageState
                  state="empty"
                  title="从第一个群开始"
                  description="每个群都有独立的规则、成员名单和审核记录。"
                  action={
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus aria-hidden="true" />
                      添加群组
                    </Button>
                  }
                />
                <div className="onboarding-steps">
                  <div>
                    <span>01</span>
                    <h3>连接群组</h3>
                    <p>使用官方事件中的群 OpenID。</p>
                  </div>
                  <div>
                    <span>02</span>
                    <h3>维护名单</h3>
                    <p>导入姓名与学号，设定核对依据。</p>
                  </div>
                  <div>
                    <span>03</span>
                    <h3>设置规则</h3>
                    <p>按群决定审核与消息处理方式。</p>
                  </div>
                </div>
              </div>
            )
          ))}
        {selectedGroupId && !detail && !detailError && (
          <PageState
            state="loading"
            title="正在读取群数据"
            description="加载配置、名单与审核记录…"
          />
        )}

        {detail && currentDraft && tab === "overview" && (
          <>
            <div className="overview-stats surface">
              <div className="overview-stat">
                <span className="stat-label">
                  待处理记录
                  <ClipboardCheck size={16} aria-hidden="true" />
                </span>
                <strong className="stat-value">
                  {detail.group.reviewCount}
                </strong>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setTab("review")}
                >
                  前往审核
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
              <div className="overview-stat">
                <span className="stat-label">
                  名单人数
                  <Users size={16} aria-hidden="true" />
                </span>
                <strong className="stat-value">
                  {detail.group.rosterCount}
                </strong>
                <span className="hint">本群独立维护</span>
              </div>
              <div className="overview-stat">
                <span className="stat-label">
                  本群自动化
                  <SlidersHorizontal size={16} aria-hidden="true" />
                </span>
                <strong className="stat-value text-value">
                  {detail.group.settings.enabled ? "已启用" : "未启用"}
                </strong>
                <span className="hint">
                  {detail.group.settings.enabled
                    ? "按已保存规则处理"
                    : "前往入群审核开启"}
                </span>
              </div>
            </div>
            <div className="overview-grid">
              <section>
                <div className="section-heading">
                  <h2>管理规则</h2>
                  <span className="hint">仅作用于本群</span>
                </div>
                <div className="surface">
                  <div className="summary-row">
                    <div className="summary-name">
                      <ShieldCheck size={16} aria-hidden="true" />
                      <div>
                        <h3>入群审核</h3>
                        <p>
                          {detail.group.settings.joinMode === "auto"
                            ? "按名单与白名单自动判断"
                            : "所有申请交由管理员审核"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="配置入群审核"
                      onClick={() => setTab("admission")}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="summary-row">
                    <div className="summary-name">
                      <MessageSquare size={16} aria-hidden="true" />
                      <div>
                        <h3>广告处理</h3>
                        <p>
                          {detail.group.settings.moderationEnabled
                            ? (
                                {
                                  observe: "仅记录，人工决定后续操作",
                                  recall: "命中规则后撤回消息",
                                  recall_mute: "命中规则后撤回并禁言",
                                } as const
                              )[detail.group.settings.moderationMode]
                            : "尚未开启消息自动处理"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="配置广告处理"
                      onClick={() => setTab("moderation")}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="summary-row">
                    <div className="summary-name">
                      <FlaskConical size={16} aria-hidden="true" />
                      <div>
                        <h3>先测试，再启用</h3>
                        <p>检查规则判断，不产生真实处置。</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="测试已保存规则"
                      onClick={() => setTab("preview")}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="section-heading section-spaced">
                  <h2>官方白名单</h2>
                  <span
                    className={`badge ${detail.group.whitelistError ? "warning" : ""}`}
                  >
                    {detail.group.whitelistError
                      ? "待同步"
                      : detail.group.strategyId
                        ? "已创建策略"
                        : "未创建策略"}
                  </span>
                </div>
                <div className="surface surface-padding page-stack">
                  <dl className="facts">
                    <div>
                      <dt>本地 QQ 白名单</dt>
                      <dd>{detail.group.settings.whitelistQQ.length} 人</dd>
                    </div>
                    <div>
                      <dt>已同步至 QQ</dt>
                      <dd>{detail.group.whitelistSynced.length} 人</dd>
                    </div>
                  </dl>
                  {detail.group.whitelistError && (
                    <Alert variant="destructive">
                      <AlertTitle>同步未完成</AlertTitle>
                      <AlertDescription>
                        {detail.group.whitelistError}。旧策略可能仍生效，请在 QQ
                        开放平台核对后重新同步。
                      </AlertDescription>
                    </Alert>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => void syncWhitelist()}
                    disabled={operationBusy || !status?.qqConfigured}
                  >
                    <RefreshCw aria-hidden="true" />
                    {whitelistBusy ? "同步中…" : "同步官方白名单"}
                  </Button>
                  {!status?.qqConfigured && (
                    <p className="hint">连接 QQ 后可同步白名单。</p>
                  )}
                </div>
              </section>
              <section>
                <div className="section-heading">
                  <h2>服务连接</h2>
                  <span
                    className={`badge ${status?.qqConfigured ? "success" : ""}`}
                  >
                    {status?.qqConfigured ? "已配置" : "未连接"}
                  </span>
                </div>
                <div className="surface surface-padding">
                  <dl className="facts">
                    <div>
                      <dt>AppID</dt>
                      <dd>{textOrDash(status?.appId)}</dd>
                    </div>
                    <div>
                      <dt>事件回调</dt>
                      <dd>
                        <code>{status?.webhookPath ?? "/qq/events"}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>记录保留</dt>
                      <dd>{status?.retentionDays ?? "—"} 天</dd>
                    </div>
                    <div>
                      <dt>最近事件</dt>
                      <dd>{formatTime(detail.group.lastEventAt)}</dd>
                    </div>
                  </dl>
                  <div className="form-divider section-spaced" />
                  <p className="hint">
                    {status?.qqConfigured
                      ? "凭据已配置；接口权限与回调连接仍以实际操作结果为准。"
                      : "规则和名单可以先行配置。连接官方机器人后，即可接收真实事件。"}
                  </p>
                  {!status?.qqConfigured && (
                    <details className="setup-details">
                      <summary>
                        <ChevronRight size={16} aria-hidden="true" />
                        查看接入步骤
                      </summary>
                      <ol>
                        <li>
                          在服务器配置 QQ AppID、AppSecret 与公网 HTTPS 地址。
                        </li>
                        <li>
                          在 QQ 开放平台将事件回调设为该公网地址下的{" "}
                          <code>/qq/events</code>。
                        </li>
                        <li>
                          重启服务并重新登录，再拉取一条真实申请验证权限。
                        </li>
                      </ol>
                      <p>密钥保留在服务器，控制台不收集。</p>
                    </details>
                  )}
                  <Button
                    variant="outline"
                    className="full-width section-spaced"
                    onClick={() => void pullRequests()}
                    disabled={operationBusy || !status?.qqConfigured}
                  >
                    <ArrowDownToLine aria-hidden="true" />
                    {pullBusy ? "拉取中…" : "拉取入群申请"}
                  </Button>
                </div>
                <div className="meta-line">
                  <span>配置版本 {detail.group.revision}</span>
                  <span>
                    群 OpenID <code>{detail.group.id}</code>
                  </span>
                </div>
              </section>
            </div>
          </>
        )}

        {detail &&
          currentDraft &&
          (tab === "admission" || tab === "moderation") && (
            <form
              onSubmit={saveSettings}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.requestSubmit();
                }
              }}
            >
              <fieldset
                className="settings-form"
                disabled={settingsBusy}
                aria-label="群配置"
              >
                {currentWorkspace?.conflict && (
                  <Alert variant="destructive">
                    <AlertTitle>配置已在另一处更新</AlertTitle>
                    <AlertDescription>
                      <div className="notice-row">
                        <span>
                          你的草稿仍保留。为避免覆盖其他修改，请先载入最新配置再编辑。
                        </span>
                        <Button
                          variant="outline"
                          onClick={() =>
                            askConfirmation({
                              title: "载入最新配置？",
                              body: "本群未提交的配置、人员与导入草稿将被丢弃，已保存的数据不受影响。",
                              confirmLabel: "丢弃并载入",
                              danger: true,
                              action: () => loadDetail(detail.group.id, false),
                            })
                          }
                        >
                          丢弃草稿并载入
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
                {settingsError && (
                  <Alert variant="destructive">
                    <AlertTitle>配置未保存</AlertTitle>
                    <AlertDescription>{settingsError}</AlertDescription>
                  </Alert>
                )}
                {tab === "admission" ? (
                  <>
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>基础设置</h2>
                        <p>给群组一个易识别的名称，并决定是否启用自动处理。</p>
                      </div>
                      <div className="surface surface-padding form-fields">
                        <div className="field">
                          <Label htmlFor="group-name">群名称</Label>
                          <Input
                            id="group-name"
                            value={currentDraft.name}
                            maxLength={100}
                            required
                            onChange={(event) =>
                              updateDraft({ name: event.target.value })
                            }
                          />
                        </div>
                        <div className="form-divider" />
                        <div className="setting-row">
                          <Label htmlFor="automation" className="setting-copy">
                            启用本群自动化
                            <span>统一控制入群审核与广告自动处理。</span>
                          </Label>
                          <Switch
                            id="automation"
                            checked={currentDraft.settings.enabled}
                            onCheckedChange={(enabled) =>
                              updateSettings({ enabled })
                            }
                          />
                        </div>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>审核方式</h2>
                        <p>
                          按问答匹配姓名与学号。匹配结果只是名单核对，不代表本人身份认证。
                        </p>
                      </div>
                      <div className="surface surface-padding form-fields">
                        <div className="field">
                          <Label htmlFor="join-mode">审核模式</Label>
                          <Select
                            value={currentDraft.settings.joinMode}
                            onValueChange={(value) =>
                              updateSettings({
                                joinMode: value as Settings["joinMode"],
                              })
                            }
                          >
                            <SelectTrigger id="join-mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="review">人工审核</SelectItem>
                              <SelectItem value="auto">
                                自动按规则审核
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="field-pair">
                          <div className="field">
                            <Label htmlFor="name-question">姓名问题标签</Label>
                            <Input
                              id="name-question"
                              value={currentDraft.settings.nameQuestion}
                              maxLength={100}
                              required
                              onChange={(event) =>
                                updateSettings({
                                  nameQuestion: event.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="field">
                            <Label htmlFor="student-question">
                              学号问题标签
                            </Label>
                            <Input
                              id="student-question"
                              value={currentDraft.settings.studentQuestion}
                              maxLength={100}
                              required
                              onChange={(event) =>
                                updateSettings({
                                  studentQuestion: event.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <p className="hint">
                          与 QQ 入群问卷的问题文字精确一致。
                        </p>
                        <div className="field">
                          <Label htmlFor="unmatched">名单未匹配时</Label>
                          <Select
                            value={currentDraft.settings.unmatched}
                            onValueChange={(value) =>
                              updateSettings({
                                unmatched: value as Settings["unmatched"],
                              })
                            }
                          >
                            <SelectTrigger id="unmatched">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="review">
                                转入人工审核
                              </SelectItem>
                              <SelectItem value="decline">拒绝入群</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="form-divider" />
                        <div className="setting-row">
                          <Label htmlFor="hold-risky" className="setting-copy">
                            风险申请转人工
                            <span>收到 QQ 风险提示时，交由管理员确认。</span>
                          </Label>
                          <Switch
                            id="hold-risky"
                            checked={currentDraft.settings.holdRisky}
                            onCheckedChange={(holdRisky) =>
                              updateSettings({ holdRisky })
                            }
                          />
                        </div>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>直接通过名单</h2>
                        <p>QQ 号与成员 OpenID 是两种不同标识，分别维护。</p>
                      </div>
                      <div className="surface surface-padding form-fields">
                        <div className="field">
                          <Label htmlFor="whitelist-qq">QQ 号白名单</Label>
                          <Textarea
                            id="whitelist-qq"
                            rows={4}
                            value={currentDraft.whitelistQQText}
                            onChange={(event) =>
                              updateDraft({
                                whitelistQQText: event.target.value,
                              })
                            }
                            placeholder="每行一个 QQ 号"
                            spellCheck={false}
                            aria-describedby="qq-whitelist-help"
                          />
                          <p className="hint" id="qq-whitelist-help">
                            启用自动化并选择自动审核后，名单会同步至 QQ
                            官方策略。命中时直接放行，跳过问答、名单和风险检查；仅添加可信
                            QQ 号。
                          </p>
                        </div>
                        <div className="form-divider" />
                        <div className="field">
                          <Label htmlFor="whitelist-members">
                            成员 OpenID 白名单
                          </Label>
                          <Textarea
                            id="whitelist-members"
                            rows={4}
                            value={currentDraft.whitelistMembersText}
                            onChange={(event) =>
                              updateDraft({
                                whitelistMembersText: event.target.value,
                              })
                            }
                            placeholder="每行一个 member_openid"
                            spellCheck={false}
                            aria-describedby="members-help"
                          />
                          <p className="hint" id="members-help">
                            使用官方事件中的 member_openid，不填 QQ
                            号。仅用于本服务判断，不同步到 QQ 官方策略。
                          </p>
                        </div>
                      </div>
                    </section>
                  </>
                ) : (
                  <>
                    {!currentDraft.settings.enabled && (
                      <Alert>
                        <AlertTitle>本群自动化尚未开启</AlertTitle>
                        <AlertDescription>
                          可先配置规则；开启入群审核页的“本群自动化”后，广告自动处理才会生效。
                        </AlertDescription>
                      </Alert>
                    )}
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>处理方式</h2>
                        <p>先记录并观察规则效果，再决定是否自动撤回或禁言。</p>
                      </div>
                      <div className="surface surface-padding form-fields">
                        <div className="setting-row">
                          <Label
                            htmlFor="moderation-enabled"
                            className="setting-copy"
                          >
                            启用广告处理
                            <span>检查消息中的文本、链接与卡片文字。</span>
                          </Label>
                          <Switch
                            id="moderation-enabled"
                            checked={currentDraft.settings.moderationEnabled}
                            onCheckedChange={(moderationEnabled) =>
                              updateSettings({ moderationEnabled })
                            }
                          />
                        </div>
                        <div className="form-divider" />
                        <div className="field">
                          <Label htmlFor="moderation-mode">命中规则后</Label>
                          <Select
                            value={currentDraft.settings.moderationMode}
                            onValueChange={(value) =>
                              updateSettings({
                                moderationMode:
                                  value as Settings["moderationMode"],
                              })
                            }
                          >
                            <SelectTrigger id="moderation-mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="observe">
                                仅记录，等待复核
                              </SelectItem>
                              <SelectItem value="recall">
                                自动撤回消息
                              </SelectItem>
                              <SelectItem value="recall_mute">
                                撤回消息并禁言
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {currentDraft.settings.moderationMode ===
                          "recall_mute" && (
                          <div className="field">
                            <Label htmlFor="mute-minutes">
                              禁言时长（分钟）
                            </Label>
                            <Input
                              id="mute-minutes"
                              type="number"
                              min={1}
                              max={43200}
                              step={1}
                              value={currentDraft.muteMinutesText}
                              onChange={(event) =>
                                updateDraft({
                                  muteMinutesText: event.target.value,
                                })
                              }
                            />
                          </div>
                        )}
                        <p className="hint">
                          QQ 撤回操作限消息发送后 2 分钟内；超时会记录实际结果。
                        </p>
                        <div className="form-divider" />
                        <div className="setting-row">
                          <Label
                            htmlFor="review-media"
                            className="setting-copy"
                          >
                            图片与附件转人工复核
                            <span>
                              目前不识别图片内容，不会将其标记为文本审核通过。
                            </span>
                          </Label>
                          <Switch
                            id="review-media"
                            checked={currentDraft.settings.reviewMedia}
                            onCheckedChange={(reviewMedia) =>
                              updateSettings({ reviewMedia })
                            }
                          />
                        </div>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>匹配规则</h2>
                        <p>
                          命中任一短语或域名时，按上方方式处理。每行填写一项。
                        </p>
                      </div>
                      <div className="surface surface-padding form-fields">
                        <div className="field">
                          <Label htmlFor="blocked-phrases">禁止短语</Label>
                          <Textarea
                            id="blocked-phrases"
                            rows={5}
                            value={currentDraft.blockedPhrasesText}
                            onChange={(event) =>
                              updateDraft({
                                blockedPhrasesText: event.target.value,
                              })
                            }
                            placeholder="例如：兼职刷单"
                          />
                        </div>
                        <div className="field">
                          <Label htmlFor="blocked-domains">禁止域名</Label>
                          <Textarea
                            id="blocked-domains"
                            rows={4}
                            value={currentDraft.blockedDomainsText}
                            onChange={(event) =>
                              updateDraft({
                                blockedDomainsText: event.target.value,
                              })
                            }
                            placeholder="例如：example.com"
                            spellCheck={false}
                            aria-describedby="domains-help"
                          />
                          <p className="hint" id="domains-help">
                            填写裸域名，不包含 https:// 或路径。
                          </p>
                        </div>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-intro">
                        <h2>豁免成员</h2>
                        <p>可信成员的消息可以跳过广告规则检查。</p>
                      </div>
                      <div className="surface surface-padding field">
                        <Label htmlFor="exempt-members">成员 OpenID</Label>
                        <Textarea
                          id="exempt-members"
                          rows={4}
                          value={currentDraft.exemptMembersText}
                          onChange={(event) =>
                            updateDraft({
                              exemptMembersText: event.target.value,
                            })
                          }
                          placeholder="每行一个 member_openid"
                          spellCheck={false}
                        />
                        <p className="hint">
                          使用官方事件中的成员 OpenID，不填 QQ 号。
                        </p>
                      </div>
                    </section>
                  </>
                )}
                <div className="save-bar">
                  <p>
                    {dirty
                      ? "有未保存的修改 · 切换页面会保留草稿"
                      : "当前配置已与服务端同步"}
                    <br />
                    保存会更新本群全部配置。
                  </p>
                  <div className="inline-actions">
                    <Button
                      variant="outline"
                      type="button"
                      disabled={!dirty || settingsBusy}
                      onClick={() =>
                        askConfirmation({
                          title: "放弃本群草稿？",
                          body: "本群未提交的配置、人员与导入草稿将被丢弃，已保存的数据不受影响。",
                          confirmLabel: "放弃草稿",
                          danger: true,
                          action: () => loadDetail(detail.group.id, false),
                        })
                      }
                    >
                      放弃修改
                    </Button>
                    <ActionButton
                      type="submit"
                      disabled={!dirty || Boolean(currentWorkspace?.conflict)}
                      state={
                        settingsBusy
                          ? "loading"
                          : settingsError
                            ? "error"
                            : "idle"
                      }
                      labels={{
                        idle: "保存配置",
                        loading: "正在保存…",
                        success: "已保存",
                        error: "重试保存",
                      }}
                    />
                  </div>
                </div>
              </fieldset>
            </form>
          )}

        {detail && tab === "roster" && currentWorkspace && (
          <>
            {personError && !currentWorkspace.person && (
              <Alert variant="destructive" className="page-message">
                <AlertDescription>{personError}</AlertDescription>
              </Alert>
            )}
            <section className="surface" aria-label="本群成员名单">
              <div className="roster-toolbar">
                <div className="search-field">
                  <Label htmlFor="roster-search" className="sr-only">
                    搜索成员名单
                  </Label>
                  <Search size={16} aria-hidden="true" />
                  <Input
                    id="roster-search"
                    type="search"
                    placeholder="搜索姓名、学号或 QQ 号"
                    value={rosterSearch}
                    onChange={(event) => setRosterSearch(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="inline-actions">
                  <Button
                    variant="outline"
                    onClick={() => setImportOpen(true)}
                    disabled={operationBusy}
                  >
                    <Upload aria-hidden="true" />
                    导入名单
                  </Button>
                  <Button
                    onClick={() => {
                      setPersonError("");
                      setPersonDraft(emptyPersonDraft());
                    }}
                    disabled={operationBusy}
                  >
                    <Plus aria-hidden="true" />
                    新增人员
                  </Button>
                </div>
              </div>
              {!detail.roster.length ? (
                <PageState
                  state="empty"
                  title="本群还没有名单"
                  description="添加人员或导入 CSV，作为入群问答的核对依据。"
                />
              ) : !visibleRoster.length ? (
                <PageState
                  state="empty"
                  title="没有匹配的成员"
                  description="试试其他姓名、学号或 QQ 号。"
                  action={
                    <Button
                      variant="outline"
                      onClick={() => setRosterSearch("")}
                    >
                      清除搜索
                    </Button>
                  }
                />
              ) : (
                <div className="table-scroll">
                  <Table className="roster-table">
                    <caption className="sr-only">本群成员名单</caption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">成员</TableHead>
                        <TableHead scope="col">学号</TableHead>
                        <TableHead scope="col">QQ 号</TableHead>
                        <TableHead scope="col">手机号</TableHead>
                        <TableHead scope="col">
                          <span className="sr-only">操作</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRoster.map((person) => (
                        <TableRow key={person.id}>
                          <TableCell>
                            <span className="table-name">{person.name}</span>
                            <span className="table-subline">
                              {person.memberOpenid ? (
                                <code>OpenID · {person.memberOpenid}</code>
                              ) : (
                                "尚未关联成员 OpenID"
                              )}
                            </span>
                          </TableCell>
                          <TableCell>{person.studentId}</TableCell>
                          <TableCell>{textOrDash(person.qq)}</TableCell>
                          <TableCell>{textOrDash(person.phone)}</TableCell>
                          <TableCell>
                            <div className="inline-actions">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`编辑${person.name}`}
                                disabled={operationBusy}
                                onClick={() => {
                                  setPersonError("");
                                  setPersonDraft({
                                    id: person.id,
                                    values: personValues(person),
                                  });
                                }}
                              >
                                <Pencil aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`删除${person.name}`}
                                disabled={operationBusy}
                                onClick={() => askDeletePerson(person)}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="table-footer">
                <span>
                  {rosterSearch
                    ? `显示 ${visibleRoster.length} / ${detail.roster.length} 人`
                    : `共 ${detail.roster.length} 人`}{" "}
                  · 名单仅供本群核对
                </span>
                <span className="mobile-hint">左右滑动查看完整字段和操作</span>
                <span>手机号不展示给群成员</span>
              </div>
            </section>
            <Dialog
              open={Boolean(currentWorkspace.person)}
              onOpenChange={(open) => {
                if (!open && !personBusy) setPersonDraft(null);
              }}
            >
              <DialogContent
                onOpenAutoFocus={(event) => {
                  if (window.matchMedia("(pointer: coarse)").matches)
                    event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  document.getElementById("roster-search")?.focus();
                }}
              >
                <DialogHeader>
                  <DialogTitle>
                    {currentWorkspace.person?.id === null
                      ? "新增人员"
                      : "编辑人员"}
                  </DialogTitle>
                  <DialogDescription>
                    姓名与学号用于入群核对，QQ 号和手机号为可选信息。
                  </DialogDescription>
                </DialogHeader>
                {currentWorkspace.person && (
                  <form className="dialog-form" onSubmit={savePerson}>
                    <fieldset className="form-fields" disabled={personBusy}>
                      <div className="field-pair">
                        <div className="field">
                          <Label htmlFor="person-name">姓名</Label>
                          <Input
                            id="person-name"
                            value={currentWorkspace.person.values.name}
                            maxLength={100}
                            required
                            onChange={(event) =>
                              updatePerson({ name: event.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <Label htmlFor="person-student-id">学号</Label>
                          <Input
                            id="person-student-id"
                            value={currentWorkspace.person.values.studentId}
                            maxLength={64}
                            required
                            onChange={(event) =>
                              updatePerson({ studentId: event.target.value })
                            }
                          />
                        </div>
                      </div>
                      <div className="field">
                        <Label htmlFor="person-qq">QQ 号（可选）</Label>
                        <Input
                          id="person-qq"
                          value={currentWorkspace.person.values.qq}
                          inputMode="numeric"
                          pattern="[1-9][0-9]{4,19}"
                          onChange={(event) =>
                            updatePerson({ qq: event.target.value })
                          }
                        />
                      </div>
                      <div className="field">
                        <Label htmlFor="person-phone">手机号（可选）</Label>
                        <Input
                          id="person-phone"
                          type="tel"
                          value={currentWorkspace.person.values.phone}
                          maxLength={32}
                          onChange={(event) =>
                            updatePerson({ phone: event.target.value })
                          }
                        />
                      </div>
                    </fieldset>
                    {personError && (
                      <p className="field-error" role="alert">
                        {personError}
                      </p>
                    )}
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={personBusy}
                        onClick={() => setPersonDraft(null)}
                      >
                        取消
                      </Button>
                      <ActionButton
                        type="submit"
                        state={
                          personBusy
                            ? "loading"
                            : personError
                              ? "error"
                              : "idle"
                        }
                        labels={{
                          idle: "保存人员",
                          loading: "正在保存…",
                          success: "已保存",
                          error: "重试保存",
                        }}
                      />
                    </DialogFooter>
                  </form>
                )}
              </DialogContent>
            </Dialog>
            <Dialog
              open={importOpen}
              onOpenChange={(open) => {
                if (!importBusy) setImportOpen(open);
              }}
            >
              <DialogContent
                className="import-dialog"
                onOpenAutoFocus={(event) => {
                  if (window.matchMedia("(pointer: coarse)").matches)
                    event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  document.getElementById("roster-search")?.focus();
                }}
              >
                <DialogHeader>
                  <DialogTitle>批量导入名单</DialogTitle>
                  <DialogDescription>
                    先预检内容，核对后再导入。所有人员仅添加到当前群。
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="dialog-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!importBusy && currentWorkspace.csv.trim())
                      void (importPreview ? commitImport() : previewImport());
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      event.currentTarget.requestSubmit();
                    }
                  }}
                >
                  <div className="field">
                    <Label htmlFor="roster-csv">CSV 内容</Label>
                    <Textarea
                      id="roster-csv"
                      rows={7}
                      value={currentWorkspace.csv}
                      onChange={(event) => setCsv(event.target.value)}
                      readOnly={importBusy}
                      spellCheck={false}
                      placeholder="姓名,学号,QQ号,手机号"
                      aria-describedby="csv-help"
                    />
                    <p className="hint" id="csv-help">
                      表头：<code>姓名,学号,QQ号,手机号</code>。QQ
                      号和手机号可留空；重复学号会阻止整批导入，不会覆盖已有人员。
                    </p>
                  </div>
                  {importError && (
                    <p className="field-error" role="alert">
                      {importError}
                    </p>
                  )}
                  {importPreview && (
                    <div className="page-stack">
                      <p className="hint">
                        <Check
                          size={16}
                          className="inline-icon"
                          aria-hidden="true"
                        />
                        预检通过 {importPreview.count} 人，尚未写入。
                      </p>
                      <div className="table-scroll">
                        <Table>
                          <caption className="sr-only">导入预检结果</caption>
                          <TableHeader>
                            <TableRow>
                              <TableHead>姓名</TableHead>
                              <TableHead>学号</TableHead>
                              <TableHead>QQ 号</TableHead>
                              <TableHead>手机号</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {importPreview.people.map((person, index) => (
                              <TableRow key={index}>
                                <TableCell>{person.name}</TableCell>
                                <TableCell>{person.studentId}</TableCell>
                                <TableCell>{textOrDash(person.qq)}</TableCell>
                                <TableCell>
                                  {textOrDash(person.phone)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setImportOpen(false)}
                      disabled={importBusy}
                    >
                      关闭
                    </Button>
                    <ActionButton
                      type="submit"
                      disabled={!currentWorkspace.csv.trim()}
                      state={importBusy ? "loading" : "idle"}
                      labels={{
                        idle: importPreview
                          ? `确认导入 ${importPreview.count} 人`
                          : "预检内容",
                        loading: "正在处理…",
                        success: "已完成",
                        error: "重试",
                      }}
                    />
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        )}

        {detail && tab === "review" && (
          <section aria-label="记录与处理">
            <div className="record-toolbar">
              <Select
                value={recordFilter}
                onValueChange={(value) =>
                  setRecordFilter(value as typeof recordFilter)
                }
              >
                <SelectTrigger aria-label="记录筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">待处理</SelectItem>
                  <SelectItem value="outcome">已有结果</SelectItem>
                  <SelectItem value="all">全部记录</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() => void pullRequests()}
                disabled={operationBusy || !status?.qqConfigured}
              >
                <ArrowDownToLine aria-hidden="true" />
                {pullBusy ? "拉取中…" : "拉取入群申请"}
              </Button>
            </div>
            {!status?.qqConfigured && (
              <p className="hint section-bottom">
                连接 QQ 后可拉取申请；已有记录仍可查看。
              </p>
            )}
            {recordError && (
              <Alert variant="destructive" className="page-message">
                <AlertDescription>{recordError}</AlertDescription>
              </Alert>
            )}
            {pendingSignature && (
              <Alert className="page-message">
                <AlertDescription>
                  有操作正在后台处理，结果会自动更新。若长时间未变化，可点击刷新。
                </AlertDescription>
              </Alert>
            )}
            <ul className="record-list">
              {visibleRecords.map((record) => {
                const actionable = [
                  "review",
                  "failed",
                  "observed",
                  "expired",
                ].includes(record.status);
                return (
                  <li key={record.id} className="record surface">
                    <div className="record-head">
                      <span className="record-avatar">
                        {record.kind === "join" ? (
                          <Users size={16} aria-hidden="true" />
                        ) : (
                          <MessageSquare size={16} aria-hidden="true" />
                        )}
                      </span>
                      <div className="record-person">
                        <strong>
                          {textOrDash(record.username)} ·{" "}
                          {record.kind === "join" ? "入群申请" : "群消息"}
                        </strong>
                        <time
                          dateTime={new Date(record.occurredAt).toISOString()}
                        >
                          {formatDateTime(record.occurredAt)}
                        </time>
                      </div>
                      <span
                        className={`badge ${record.status === "succeeded" ? "success" : record.status === "failed" ? "error" : ["review", "observed", "expired"].includes(record.status) ? "warning" : ""}`}
                      >
                        {statusLabels[record.status] ?? record.status}
                      </span>
                    </div>
                    <div className="record-content">
                      {record.content || "无文本内容，可能为图片或附件。"}
                    </div>
                    <dl className="record-decision">
                      <div>
                        <dt>处理决定</dt>
                        <dd>
                          {decisionLabels[record.decision] ?? record.decision} ·{" "}
                          {record.reason || "无额外说明"}
                        </dd>
                      </div>
                      <div>
                        <dt>执行结果</dt>
                        <dd>
                          {record.outcome ||
                            (record.status === "queued"
                              ? "等待后台执行"
                              : record.status === "processing"
                                ? "正在执行"
                                : "暂无执行结果")}
                        </dd>
                      </div>
                      {record.error && (
                        <div>
                          <dt>失败原因</dt>
                          <dd className="field-error">{record.error}</dd>
                        </div>
                      )}
                    </dl>
                    <details className="record-details">
                      <summary>
                        <CircleHelp size={16} aria-hidden="true" />
                        记录详情
                      </summary>
                      <p>
                        记录 #{record.id} · 成员 OpenID{" "}
                        <code>{record.memberOpenid}</code>
                      </p>
                    </details>
                    {actionable && (
                      <div className="record-actions">
                        {record.kind === "join" ? (
                          <>
                            <Button
                              variant="outline"
                              disabled={Boolean(actionBusy)}
                              onClick={() => askRecordAction(record, "decline")}
                            >
                              拒绝
                            </Button>
                            <Button
                              disabled={Boolean(actionBusy)}
                              onClick={() =>
                                void runRecordAction(record, "approve")
                              }
                            >
                              通过申请
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              disabled={Boolean(actionBusy)}
                              onClick={() => askRecordAction(record, "recall")}
                            >
                              撤回消息
                            </Button>
                            <Button
                              variant="outline"
                              disabled={Boolean(actionBusy)}
                              onClick={() =>
                                askRecordAction(record, "recall_mute")
                              }
                            >
                              撤回并禁言
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          disabled={Boolean(actionBusy)}
                          onClick={() => void runRecordAction(record, "ignore")}
                        >
                          忽略
                        </Button>
                        {actionBusy?.startsWith(`${record.id}:`) && (
                          <span className="hint" role="status">
                            正在提交…
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {!visibleRecords.length && (
              <div className="surface">
                <PageState
                  state="empty"
                  title={
                    detail.records.length
                      ? "当前没有符合条件的记录"
                      : "还没有收到记录"
                  }
                  description={
                    detail.records.length
                      ? "切换筛选查看其他处理结果。"
                      : "收到入群申请或消息事件后，会显示在这里。"
                  }
                  action={
                    detail.records.length ? (
                      <Button
                        variant="outline"
                        onClick={() => setRecordFilter("all")}
                      >
                        查看全部记录
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            )}
            {hasMoreRecords && (
              <Button
                variant="outline"
                className="section-spaced"
                onClick={() => void loadOlderRecords()}
                disabled={recordsBusy}
              >
                {recordsBusy ? "正在加载…" : "加载更早的记录"}
              </Button>
            )}
          </section>
        )}

        {detail && tab === "preview" && (
          <>
            {dirty && (
              <Alert className="page-message">
                <AlertTitle>请先保存配置</AlertTitle>
                <AlertDescription>
                  测试只读取已保存规则。当前草稿尚未保存，可回到入群审核或广告处理页保存。
                </AlertDescription>
              </Alert>
            )}
            <div className="preview-layout">
              <form
                className="surface surface-padding form-fields"
                onSubmit={runPreview}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    event.currentTarget.requestSubmit();
                  }
                }}
              >
                <div className="field">
                  <Label htmlFor="preview-kind">测试类型</Label>
                  <Select
                    value={previewKind}
                    onValueChange={(value) => {
                      setPreviewKind(value as "join" | "message");
                      setPreviewResult(null);
                    }}
                    disabled={previewBusy}
                  >
                    <SelectTrigger id="preview-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="join">入群问答</SelectItem>
                      <SelectItem value="message">消息文本</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="field">
                  <Label htmlFor="preview-text">
                    {previewKind === "join" ? "入群答案文本" : "消息文本"}
                  </Label>
                  <Textarea
                    id="preview-text"
                    rows={9}
                    readOnly={previewBusy}
                    value={previewText}
                    onChange={(event) => {
                      setPreviewText(event.target.value);
                      setPreviewResult(null);
                    }}
                    placeholder={
                      previewKind === "join"
                        ? `姓名：示例姓名\n学号：20260001`
                        : "粘贴需要检查的文本、链接或卡片文字"
                    }
                    aria-describedby="preview-help"
                  />
                  <p id="preview-help" className="hint">
                    {previewKind === "join"
                      ? "每行一条“问题标签：答案”，标签需与本群配置一致。"
                      : "仅检查文本规则，图片内容不在本次测试范围内。"}
                  </p>
                </div>
                {previewError && (
                  <p className="field-error" role="alert">
                    {previewError}
                  </p>
                )}
                <ActionButton
                  type="submit"
                  disabled={dirty}
                  state={
                    previewBusy ? "loading" : previewError ? "error" : "idle"
                  }
                  labels={{
                    idle: "运行规则测试",
                    loading: "正在检查…",
                    success: "已完成",
                    error: "重试测试",
                  }}
                />
              </form>
              <section className="surface preview-result" aria-live="polite">
                <h2>测试结果</h2>
                {previewResult ? (
                  <>
                    <strong className="preview-verdict">
                      {decisionLabels[previewResult.decision] ??
                        previewResult.decision}
                    </strong>
                    <p>{previewResult.reason}</p>
                    {previewResult.personId !== undefined && (
                      <p>匹配名单人员 #{previewResult.personId}</p>
                    )}
                  </>
                ) : (
                  <>
                    <FlaskConical size={24} aria-hidden="true" />
                    <p>输入一段内容，看看规则会如何判断。</p>
                  </>
                )}
                <div className="form-divider section-spaced" />
                <p className="hint">
                  {!detail.group.settings.enabled
                    ? "本群自动化未开启。"
                    : previewKind === "message" &&
                        !detail.group.settings.moderationEnabled
                      ? "广告自动处理未开启。"
                      : "使用本群当前已保存规则。"}
                  测试不产生真实入群审批、撤回或禁言。
                </p>
              </section>
            </div>
          </>
        )}
      </ContentContainer>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!groupsBusy) setCreateOpen(open);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            if (window.matchMedia("(pointer: coarse)").matches)
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("add-group")?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>添加群组</DialogTitle>
            <DialogDescription>
              使用 QQ 官方事件中的群 OpenID 连接群组；它与 QQ 群号不同。
            </DialogDescription>
          </DialogHeader>
          <form className="dialog-form" onSubmit={createGroup}>
            <fieldset className="form-fields" disabled={groupsBusy}>
              <div className="field">
                <Label htmlFor="new-group-name">群名称</Label>
                <Input
                  id="new-group-name"
                  value={controlState.newGroupName}
                  onChange={(event) =>
                    setControlState((state) => ({
                      ...state,
                      newGroupName: event.target.value,
                    }))
                  }
                  maxLength={100}
                  placeholder="例如：2026 级年级群"
                  required
                />
              </div>
              <div className="field">
                <Label htmlFor="new-group-id">群 OpenID</Label>
                <Input
                  id="new-group-id"
                  value={controlState.newGroupId}
                  onChange={(event) =>
                    setControlState((state) => ({
                      ...state,
                      newGroupId: event.target.value,
                    }))
                  }
                  pattern="[A-Za-z0-9_-]+"
                  maxLength={128}
                  placeholder="group_openid"
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
              </div>
            </fieldset>
            {groupsError && (
              <p className="field-error" role="alert">
                {groupsError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={groupsBusy}
              >
                取消
              </Button>
              <ActionButton
                type="submit"
                state={groupsBusy ? "loading" : "idle"}
                labels={{
                  idle: "添加群组",
                  loading: "正在添加…",
                  success: "已添加",
                  error: "重试",
                }}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (confirmationTrigger.current?.isConnected
              ? confirmationTrigger.current
              : document.getElementById("main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.body}</DialogDescription>
          </DialogHeader>
          <form onSubmit={confirmDialogSubmit}>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmation(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant={confirmation?.danger ? "destructive" : "default"}
              >
                {confirmation?.confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
