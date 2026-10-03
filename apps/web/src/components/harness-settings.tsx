"use client";
import { useEffect, useState } from "react";
import type {
  AgentResource,
  HarnessSettings,
  McpConnection,
  Project,
  ToolInfo,
} from "@memory/contracts";
import { Plus, Save, Trash2, Shield, Plug, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
const newResource = (): AgentResource => ({
  id: "",
  kind: "skill",
  name: "",
  description: "",
  content: "",
  enabled: true,
});
const newMcp = (): McpConnection => ({
  id: "",
  name: "",
  transport: "http",
  url: "",
  command: "",
  args: [],
  enabled: true,
});
export function HarnessSettingsPanel({
  project,
  tools,
  onProject,
}: {
  project: Project;
  tools: ToolInfo[];
  onProject: () => void;
}) {
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [form, setForm] = useState(project);
  const [searchKey, setSearchKey] = useState("");
  const [resource, setResource] = useState<AgentResource | null>(null);
  const [mcp, setMcp] = useState<McpConnection | null>(null);
  const [mcpArgs, setMcpArgs] = useState("");
  const [secrets, setSecrets] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () =>
    setSettings(await api<HarnessSettings>("/harness"));
  useEffect(() => {
    setForm(project);
  }, [project]);
  useEffect(() => {
    void refresh().catch((e) => setMessage(e.message));
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
      onProject();
      setMessage("已保存");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Tabs defaultValue="permissions">
        <TabsList
          variant="line"
          className="mb-6 flex w-full justify-start gap-3 border-b p-0"
        >
          <TabsTrigger value="permissions">
            <Shield className="size-3.5" />
            权限
          </TabsTrigger>
          <TabsTrigger value="runtime">运行配置</TabsTrigger>
          <TabsTrigger value="skills">
            <BookOpen className="size-3.5" />
            Skills
          </TabsTrigger>
          <TabsTrigger value="mcp">
            <Plug className="size-3.5" />
            MCP
          </TabsTrigger>
        </TabsList>
        <TabsContent value="permissions" className="space-y-5">
          <Card className="gap-5 rounded-xl border py-5 shadow-none">
            <CardHeader>
              <CardTitle className="text-sm">{project.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field>
                <FieldLabel>工作目录</FieldLabel>
                <Input
                  aria-label="当前工作目录"
                  value={project.directory}
                  readOnly
                  className="font-mono text-xs"
                />
              </Field>
              <Field>
                <FieldLabel>项目指令</FieldLabel>
                <Textarea
                  aria-label="项目指令"
                  rows={6}
                  value={form.instructions}
                  onChange={(e) =>
                    setForm({ ...form, instructions: e.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel>默认权限</FieldLabel>
                <Select
                  value={form.permissionMode}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      permissionMode: v as Project["permissionMode"],
                    })
                  }
                >
                  <SelectTrigger aria-label="默认权限">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">只读</SelectItem>
                    <SelectItem value="ask">操作前询问</SelectItem>
                    <SelectItem value="auto">项目内自动执行</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="shell-network">
                  允许终端与本地 MCP 访问主机网络
                </FieldLabel>
                <Switch
                  id="shell-network"
                  checked={form.network}
                  onCheckedChange={(network) => setForm({ ...form, network })}
                />
              </Field>
              <div className="divide-y">
                {tools.map((tool) => (
                  <Field
                    orientation="horizontal"
                    key={tool.name}
                    className="py-3"
                  >
                    <FieldLabel htmlFor={"tool-" + tool.name}>
                      {tool.label}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {tool.name}
                      </span>
                    </FieldLabel>
                    <Switch
                      id={"tool-" + tool.name}
                      checked={!form.disabledTools.includes(tool.name)}
                      onCheckedChange={(enabled) =>
                        setForm({
                          ...form,
                          disabledTools: enabled
                            ? form.disabledTools.filter((n) => n !== tool.name)
                            : [...form.disabledTools, tool.name],
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <Button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api("/projects/" + project.id, {
                      method: "PATCH",
                      body: JSON.stringify({
                        instructions: form.instructions,
                        permissionMode: form.permissionMode,
                        network: form.network,
                        disabledTools: form.disabledTools,
                      }),
                    }),
                  )
                }
              >
                <Save />
                保存项目设置
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="runtime" className="space-y-5">
          <Card className="gap-5 rounded-xl border py-5 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                执行环境
                <Badge variant="outline">
                  {settings?.sandbox.available ? "已隔离" : "不可用"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field orientation="horizontal">
                <FieldLabel htmlFor="auto-compact">自动压缩上下文</FieldLabel>
                <Switch
                  id="auto-compact"
                  checked={settings?.autoCompaction || false}
                  disabled={busy}
                  onCheckedChange={(autoCompaction) =>
                    void action(() =>
                      api("/harness", {
                        method: "PATCH",
                        body: JSON.stringify({ autoCompaction }),
                      }),
                    )
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="auto-retry">连接失败自动重试</FieldLabel>
                <Switch
                  id="auto-retry"
                  checked={settings?.retry || false}
                  disabled={busy}
                  onCheckedChange={(retry) =>
                    void action(() =>
                      api("/harness", {
                        method: "PATCH",
                        body: JSON.stringify({ retry }),
                      }),
                    )
                  }
                />
              </Field>
            </CardContent>
          </Card>
          <Card className="gap-5 rounded-xl border py-5 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                Exa 搜索
                <Badge variant="outline">
                  {settings?.search.configured ? "已配置" : "未配置"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field>
                <FieldLabel>API key</FieldLabel>
                <Input
                  aria-label="Exa API key"
                  type="password"
                  autoComplete="off"
                  value={searchKey}
                  onChange={(e) => setSearchKey(e.target.value)}
                  placeholder={
                    settings?.search.configured
                      ? "已保存，留空保留"
                      : "输入 API key"
                  }
                />
              </Field>
              <div className="flex justify-between">
                <Switch
                  aria-label="启用 Exa 搜索"
                  checked={settings?.search.enabled || false}
                  disabled={busy}
                  onCheckedChange={(searchEnabled) =>
                    void action(() =>
                      api("/harness", {
                        method: "PATCH",
                        body: JSON.stringify({ searchEnabled }),
                      }),
                    )
                  }
                />
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api("/harness", {
                        method: "PATCH",
                        body: JSON.stringify({
                          searchKey,
                          searchEnabled: true,
                        }),
                      });
                      setSearchKey("");
                    })
                  }
                >
                  保存搜索配置
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="skills" className="space-y-4">
          <Button variant="outline" onClick={() => setResource(newResource())}>
            <Plus />
            添加资源
          </Button>
          {settings?.resources.map((r) => (
            <Card key={r.id} className="gap-0 rounded-lg py-0 shadow-none">
              <CardContent className="flex items-center gap-3 px-3 py-3">
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => setResource(r)}
                >
                  <BookOpen />
                  <span className="truncate">{r.name}</span>
                  <Badge variant="outline">
                    {r.kind === "skill" ? "Skill" : "提示词"}
                  </Badge>
                </Button>
                <Switch
                  aria-label={"启用 " + r.name}
                  checked={r.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void action(() =>
                      api("/harness/resources", {
                        method: "POST",
                        body: JSON.stringify({ ...r, enabled }),
                      }),
                    )
                  }
                />
                <Button
                  aria-label={"删除 " + r.name}
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api("/harness/resources/" + r.id, { method: "DELETE" }),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
        <TabsContent value="mcp" className="space-y-4">
          <Button
            variant="outline"
            onClick={() => {
              setMcp(newMcp());
              setMcpArgs("");
              setSecrets("");
            }}
          >
            <Plus />
            连接 MCP
          </Button>
          {settings?.mcp.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex items-center gap-3 px-3 py-3">
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => {
                    setMcp(s);
                    setMcpArgs(s.args.join("\n"));
                    setSecrets("");
                  }}
                >
                  <Plug />
                  <span className="truncate">{s.name}</span>
                  <Badge variant="outline">{s.transport}</Badge>
                </Button>
                <Switch
                  aria-label={"启用 " + s.name}
                  checked={s.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void action(() => {
                      const { hasSecrets, ...server } = s;
                      return api("/harness/mcp", {
                        method: "POST",
                        body: JSON.stringify({ ...server, enabled }),
                      });
                    })
                  }
                />
                <Button
                  aria-label={"删除 " + s.name}
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api("/harness/mcp/" + s.id, { method: "DELETE" }),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Dialog
        open={!!resource}
        onOpenChange={(open) => {
          if (!open) setResource(null);
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{resource?.id ? "编辑资源" : "添加资源"}</DialogTitle>
          </DialogHeader>
          {resource && (
            <div className="space-y-4">
              <Select
                value={resource.kind}
                onValueChange={(v) =>
                  setResource({ ...resource, kind: v as AgentResource["kind"] })
                }
              >
                <SelectTrigger aria-label="资源类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skill">Skill</SelectItem>
                  <SelectItem value="prompt">提示词模板</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label="资源名称"
                placeholder="name"
                value={resource.name}
                onChange={(e) =>
                  setResource({ ...resource, name: e.target.value })
                }
              />
              <Input
                aria-label="资源描述"
                placeholder="描述"
                value={resource.description}
                onChange={(e) =>
                  setResource({ ...resource, description: e.target.value })
                }
              />
              <Textarea
                aria-label="资源内容"
                rows={14}
                value={resource.content}
                onChange={(e) =>
                  setResource({ ...resource, content: e.target.value })
                }
                className="font-mono text-xs"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={busy || !resource?.name}
              onClick={() =>
                void action(async () => {
                  if (resource) {
                    const { id, ...r } = resource;
                    await api("/harness/resources", {
                      method: "POST",
                      body: JSON.stringify({ ...r, ...(id ? { id } : {}) }),
                    });
                    setResource(null);
                  }
                })
              }
            >
              保存资源
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!mcp}
        onOpenChange={(open) => {
          if (!open) {
            setMcp(null);
            setSecrets("");
          }
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-auto">
          <DialogHeader>
            <DialogTitle>MCP 连接</DialogTitle>
          </DialogHeader>
          {mcp && (
            <div className="space-y-4">
              <Input
                aria-label="MCP 名称"
                placeholder="server-name"
                value={mcp.name}
                onChange={(e) => setMcp({ ...mcp, name: e.target.value })}
              />
              <Select
                value={mcp.transport}
                onValueChange={(v) =>
                  setMcp({ ...mcp, transport: v as McpConnection["transport"] })
                }
              >
                <SelectTrigger aria-label="MCP 传输">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">Streamable HTTP</SelectItem>
                  <SelectItem value="stdio">本地进程 · 隔离执行</SelectItem>
                </SelectContent>
              </Select>
              {mcp.transport === "http" ? (
                <Input
                  aria-label="MCP URL"
                  placeholder="https://example.com/mcp"
                  value={mcp.url}
                  onChange={(e) => setMcp({ ...mcp, url: e.target.value })}
                />
              ) : (
                <>
                  <Input
                    aria-label="MCP 命令"
                    placeholder="python3"
                    value={mcp.command}
                    onChange={(e) =>
                      setMcp({ ...mcp, command: e.target.value })
                    }
                  />
                  <Textarea
                    aria-label="MCP 参数"
                    placeholder="每行一个参数"
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                  />
                </>
              )}
              <Field>
                <FieldLabel>
                  {mcp.transport === "http" ? "请求头" : "环境变量"} · JSON
                </FieldLabel>
                <Textarea
                  aria-label="MCP 认证"
                  autoComplete="off"
                  placeholder={mcp.hasSecrets ? "已保存，留空保留" : "{}"}
                  value={secrets}
                  onChange={(e) => setSecrets(e.target.value)}
                  className="font-mono text-xs"
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={busy || !mcp?.name}
              onClick={() =>
                void action(async () => {
                  if (mcp) {
                    const { id, hasSecrets, ...s } = mcp;
                    await api("/harness/mcp", {
                      method: "POST",
                      body: JSON.stringify({
                        ...s,
                        ...(id ? { id } : {}),
                        args: mcpArgs.split("\n").filter(Boolean),
                        ...(secrets.trim()
                          ? {
                              [s.transport === "http" ? "headers" : "env"]:
                                JSON.parse(secrets),
                            }
                          : {}),
                      }),
                    });
                    setSecrets("");
                    setMcp(null);
                  }
                })
              }
            >
              保存连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
