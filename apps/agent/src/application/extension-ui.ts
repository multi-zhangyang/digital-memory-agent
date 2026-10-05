import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { Theme, type ThemeColor, type ThemeBg, type ExtensionUIDialogOptions, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { applyPartEvent } from "@memory/contracts/execution";
import type { ExtensionPresentation } from "@memory/contracts";
import type { Store } from "../store.js";
import { requestApproval } from "../permissions.js";

type PresentationRecord = ExtensionPresentation & { id: string; conversationId: string };
// Pi reads this property while binding the SDK UI. These terminal-default tokens
// support text formatting; Web components own appearance and strip ANSI codes.
const textTheme = new Theme(Object.fromEntries(("accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode").split(" ").map((key) => [key, ""])) as Record<ThemeColor, string>,
  Object.fromEntries("selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg".split(" ").map((key) => [key, ""])) as Record<ThemeBg, string>, "truecolor", { name: "web-text", appearance: "dark" });
export function extensionPresentation(store: Store, conversationId: string): ExtensionPresentation {
  const value = store.work.get<PresentationRecord>("session-ui", "ui:" + conversationId);
  return value ? { statuses: value.statuses, widgets: value.widgets, title: value.title, editor: value.editor } : { statuses: {}, widgets: {} };
}
export function savePresentation(store: Store, conversationId: string, value: ExtensionPresentation, publish = true) {
  store.work.save("session-ui", { ...value, id: "ui:" + conversationId, conversationId });
  const run = publish && store.work.activeRun(conversationId);
  if (run) store.work.patchRun(run.id, { extensionUI: value }, "extension-ui");
}

/** Web adapter for Pi's UI port. Execution and dialog decisions remain server owned. */
export function createExtensionUI(store: Store, conversationId: string, statuses: Record<string, string>): ExtensionUIContext {
  Object.assign(statuses, extensionPresentation(store, conversationId).statuses);
  const clean = (value: string) => {
    const secrets = [store.harness.settings.searchKey, ...store.harness.settings.mcp.flatMap((server) =>
      [...Object.values(server.headers || {}), ...Object.values(server.env || {})])].filter(Boolean);
    return stripVTControlCharacters(secrets.reduce((text, secret) => text.split(secret).join("[已隐藏]"), value));
  };
  const update = (patch: Partial<ExtensionPresentation>) => savePresentation(store, conversationId, { ...extensionPresentation(store, conversationId), ...patch });
  const setStatus = (key: string, value?: string) => {
    if (value) statuses[key] = clean(value);
    else delete statuses[key];
    update({ statuses: { ...statuses } });
  };
  const unsupported = (name: string) => setStatus("web-compatibility", name + " 需要终端界面");
  const awaitDecision = async (input: Parameters<typeof requestApproval>[2], options?: ExtensionUIDialogOptions) => {
    if (options?.signal?.aborted || (options?.timeout !== undefined && options.timeout <= 0)) return undefined;
    const approval = await requestApproval(store, conversationId, { ...input,
      ...(options?.timeout ? { expiresAt: new Date(Date.now() + options.timeout).toISOString() } : {}) });
    if (approval.status !== "pending") return approval;
    if (options?.signal) options.signal.addEventListener("abort", () => {
      const current = store.harness.get<typeof approval>("approval", approval.id);
      if (current?.status === "pending") store.harness.save("approval", { ...current, status: "denied", resolution: "cancelled" });
    }, { once: true });
    // The durable task yields; the same request returns the saved answer on resume.
    throw new Error("等待用户处理扩展请求后继续");
  };
  const setEditorText = (text: string) => update({ editor: { text, revision: randomUUID(), source: "extension" } });
  return {
    select: async (title, options, opts) => {
      const answer = await awaitDecision({ title, detail: "", kind: "select", options }, opts);
      return answer?.status === "approved" ? answer.answer : undefined;
    },
    confirm: async (title, detail, opts) => (await awaitDecision({ title, detail, kind: "confirm", options: [] }, opts))?.status === "approved",
    input: async (title, placeholder, opts) => {
      const answer = await awaitDecision({ title, detail: "", placeholder, kind: "input", options: [] }, opts);
      return answer?.status === "approved" ? answer.answer : undefined;
    },
    editor: async (title, prefill) => {
      const answer = await awaitDecision({ title, detail: "", prefill, kind: "input", options: [] });
      return answer?.status === "approved" ? answer.answer : undefined;
    },
    notify: (message, type) => {
      const text = clean(message);
      setStatus("notification", text);
      if (type === "error" || type === "warning") for (const server of store.harness.settings.mcp)
        if (text.includes(server.name + ":")) setStatus("mcp:" + server.name, "连接失败或需要认证");
      const run = store.work.activeRun(conversationId);
      if (run) {
        const event = { type: "notice" as const, id: randomUUID(), text, state: type === "error" ? "error" as const : "complete" as const };
        store.work.patchRun(run.id, { parts: applyPartEvent(run.parts, event) }, "notice", event);
      }
    },
    setStatus,
    setWorkingMessage: (text) => setStatus("working", text),
    setWidget: (key, content, options) => {
      if (typeof content === "function") { unsupported("组件式 Widget"); return; }
      const widgets = { ...extensionPresentation(store, conversationId).widgets };
      if (content) widgets[key] = { lines: content.map(clean), placement: options?.placement || "aboveEditor" };
      else delete widgets[key];
      update({ widgets });
    },
    setTitle: (title) => update({ title: clean(title) }),
    setEditorText,
    pasteToEditor: (text) => setEditorText((extensionPresentation(store, conversationId).editor?.text || "") + text),
    getEditorText: () => extensionPresentation(store, conversationId).editor?.text || "",
    custom: async () => { throw new Error("此扩展请求终端组件，Web 工作台不支持此界面"); },
    setFooter: (factory) => { if (factory) unsupported("自定义页脚"); },
    setHeader: (factory) => { if (factory) unsupported("自定义页首"); },
    setEditorComponent: (factory) => { if (factory) unsupported("自定义编辑器"); },
    getEditorComponent: () => undefined,
    addAutocompleteProvider: () => unsupported("终端自动补全"),
    onTerminalInput: () => { unsupported("终端按键监听"); return () => {}; },
    setWorkingVisible: () => {}, // Web execution state cannot be hidden by an extension.
    setWorkingIndicator: () => {}, // The official AI Elements loader owns animation.
    setHiddenThinkingLabel: () => {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "主题由 WebUI 管理" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => unsupported("统一工具折叠设置"),
    theme: textTheme,
  };
}
