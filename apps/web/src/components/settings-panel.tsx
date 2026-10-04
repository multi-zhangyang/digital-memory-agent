"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type {
  ConnectionUpdate,
  ModelConfiguration,
  Project,
  ProviderStatus,
  ThinkingLevel,
  ToolInfo,
} from "@memory/contracts";
import { LoaderCircle, Plug, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { HarnessSettingsPanel } from "./harness-settings";
import { MemorySettingsPanel } from "./memory-settings";

export function SettingsPanel({
  configuration,
  tools,
  onRefresh,
  project,
}: {
  configuration: ModelConfiguration | null;
  tools: ToolInfo[];
  project?: Project;
  onRefresh: () => Promise<void>;
}) {
  const [added, setAdded] = useState<ProviderStatus | null>(null);
  const [selected, setSelected] = useState("openai-compatible");
  const providers = [
    ...(configuration?.providers || []),
    ...(added && !configuration?.providers.some((item) => item.id === added.id)
      ? [added]
      : []),
  ];
  function addProvider() {
    const next: ProviderStatus = {
      id: "connection-" + crypto.randomUUID().slice(0, 8),
      name: "新连接",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      modelName: "",
      protocol: "openai-responses",
      contextWindow: 256000,
      maxTokens: 16384,
      reasoning: true,
      thinkingLevel: "medium",
      configured: false,
      missing: [],
      hasApiKey: false,
    };
    setAdded(next);
    setSelected(next.id);
  }
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-10 lg:px-12"
      data-testid="settings-page"
    >
      <div className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-medium tracking-tight">设置</h1>
        <Tabs
          defaultValue="models"
          orientation="vertical"
          className="mt-9 flex-col gap-8 md:flex-row md:gap-12"
        >
          <TabsList className="w-full shrink-0 items-stretch gap-1 bg-transparent p-0 md:sticky md:top-0 md:w-40">
            <TabsTrigger
              value="models"
              className="h-9 flex-none justify-start px-3 text-sm font-normal"
            >
              <Plug className="size-4" />
              模型连接
            </TabsTrigger>
            <TabsTrigger
              value="harness"
              className="h-9 flex-none justify-start px-3 text-sm font-normal"
            >
              <Settings2 className="size-4" />
              Agent 配置
            </TabsTrigger>
            <TabsTrigger value="memory">个人记忆</TabsTrigger>
          </TabsList>
          <TabsContent value="models" className="min-w-0 space-y-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-medium">模型连接</h2>
              <Button variant="outline" size="sm" onClick={addProvider}>
                <Plus className="size-3.5" />
                添加模型连接
              </Button>
            </div>
            <Accordion
              type="single"
              collapsible
              value={selected}
              onValueChange={setSelected}
              className="rounded-xl border px-5 sm:px-6"
            >
              {providers.map((provider) => (
                <AccordionItem key={provider.id} value={provider.id}>
                  <AccordionTrigger className="py-5 hover:no-underline">
                    <div className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <Plug className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {provider.name}
                        </p>
                        {provider.modelName && (
                          <p className="mt-1 truncate text-xs font-normal text-muted-foreground">
                            {provider.modelName}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className="mr-1 shrink-0 font-normal"
                      >
                        {provider.configured
                          ? provider.enabled
                            ? "已启用"
                            : "已停用"
                          : "未配置"}
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-6">
                    <ProviderForm provider={provider} onRefresh={onRefresh} />
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </TabsContent>
          <TabsContent value="harness" className="min-w-0">
            {project && (
              <HarnessSettingsPanel
                project={project}
                tools={tools}
                onProject={() => void onRefresh()}
              />
            )}
          </TabsContent>
          <TabsContent value="memory" className="min-w-0"><MemorySettingsPanel models={configuration?.models || []} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function values(provider: ProviderStatus): ConnectionUpdate {
  return {
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    modelName: provider.modelName,
    protocol: provider.protocol,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
    reasoning: provider.reasoning,
    thinkingLevel: provider.thinkingLevel,
    supportsImages: provider.supportsImages ?? false,
  };
}

function ProviderForm({
  provider,
  onRefresh,
}: {
  provider: ProviderStatus;
  onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<ConnectionUpdate>(() => values(provider));
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setForm(values(provider));
    setApiKey("");
  }, [provider]);
  const update = <K extends keyof ConnectionUpdate>(
    name: K,
    value: ConnectionUpdate[K],
  ) => setForm((current) => ({ ...current, [name]: value }));

  async function save(test: boolean) {
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      await api("/settings/providers/" + provider.id, {
        method: "POST",
        body: JSON.stringify({
          ...form,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      setApiKey("");
      await onRefresh();
      if (test) {
        const result = await api<{ ok: boolean; latencyMs: number }>(
          "/settings/providers/" + provider.id + "/test",
          { method: "POST" },
        );
        setMessage("已连接 · " + (result.latencyMs / 1000).toFixed(1) + " s");
      } else setMessage("已保存");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const fieldId = (name: string) => provider.id + "-" + name;
  return (
    <Card className="gap-0 border-0 bg-transparent py-0 shadow-none">
      <form
        data-testid={"provider-" + provider.id}
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <CardContent className="px-0 py-3">
          <FieldSet disabled={busy}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={fieldId("url")}>接口地址</FieldLabel>
                <Input
                  id={fieldId("url")}
                  aria-label="接口地址"
                  value={form.baseUrl}
                  onChange={(event) => update("baseUrl", event.target.value)}
                  placeholder="https://api.example.com/v1"
                  required
                />
              </Field>
              <div className="grid gap-6 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={fieldId("key")}>API key</FieldLabel>
                  <Input
                    id={fieldId("key")}
                    aria-label="API key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      provider.hasApiKey ? "已保存 · 留空保留" : "sk-…"
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={fieldId("model")}>模型名称</FieldLabel>
                  <Input
                    id={fieldId("model")}
                    aria-label="模型名称"
                    value={form.modelName}
                    onChange={(event) =>
                      update("modelName", event.target.value)
                    }
                    placeholder="model-id"
                  />
                </Field>
              </div>
              <Accordion
                type="single"
                collapsible
                defaultValue={provider.configured ? "parameters" : undefined}
              >
                <AccordionItem value="parameters">
                  <AccordionTrigger>模型参数</AccordionTrigger>
                  <AccordionContent>
                    <FieldGroup>
                      <div className="grid gap-6 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor={fieldId("protocol")}>
                            协议
                          </FieldLabel>
                          <Select
                            value={form.protocol}
                            disabled={busy}
                            onValueChange={(value) =>
                              update(
                                "protocol",
                                value as ConnectionUpdate["protocol"],
                              )
                            }
                          >
                            <SelectTrigger
                              id={fieldId("protocol")}
                              aria-label="协议"
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="anthropic-messages">
                                Anthropic Messages
                              </SelectItem>
                              <SelectItem value="openai-completions">
                                Chat Completions
                              </SelectItem>
                              <SelectItem value="openai-responses">
                                Responses
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={fieldId("context")}>
                            上下文窗口
                          </FieldLabel>
                          <Input
                            id={fieldId("context")}
                            aria-label="上下文窗口"
                            type="number"
                            min={8192}
                            max={2000000}
                            value={form.contextWindow}
                            onChange={(event) =>
                              update(
                                "contextWindow",
                                Number(event.target.value),
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={fieldId("output")}>
                            最大输出
                          </FieldLabel>
                          <Input
                            id={fieldId("output")}
                            aria-label="最大输出"
                            type="number"
                            min={256}
                            max={128000}
                            value={form.maxTokens}
                            onChange={(event) =>
                              update("maxTokens", Number(event.target.value))
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={fieldId("thinking")}>
                            思考强度
                          </FieldLabel>
                          <Select
                            value={form.thinkingLevel}
                            disabled={!form.reasoning || busy}
                            onValueChange={(value) =>
                              update("thinkingLevel", value as ThinkingLevel)
                            }
                          >
                            <SelectTrigger
                              id={fieldId("thinking")}
                              aria-label="思考强度"
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {[
                                "off",
                                "minimal",
                                "low",
                                "medium",
                                "high",
                                "xhigh",
                                "max",
                              ].map((level) => (
                                <SelectItem value={level} key={level}>
                                  {level}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      <Field orientation="horizontal">
                        <Switch
                          id={fieldId("reasoning")}
                          aria-label="思考模型"
                          disabled={busy}
                          checked={form.reasoning}
                          onCheckedChange={(checked) =>
                            setForm((current) => ({
                              ...current,
                              reasoning: checked,
                              thinkingLevel: checked
                                ? current.thinkingLevel === "off"
                                  ? "medium"
                                  : current.thinkingLevel
                                : "off",
                            }))
                          }
                        />
                        <FieldLabel htmlFor={fieldId("reasoning")}>
                          思考模型
                        </FieldLabel>
                      </Field>
                      <Field orientation="horizontal">
                        <Switch id={fieldId("vision")} aria-label="支持图片输入" disabled={busy}
                          checked={form.supportsImages ?? false} onCheckedChange={(checked) => update("supportsImages", checked)} />
                        <FieldLabel htmlFor={fieldId("vision")}>支持图片输入</FieldLabel>
                      </Field>
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <Field orientation="horizontal">
                <Switch
                  id={fieldId("enabled")}
                  aria-label="启用连接"
                  disabled={busy}
                  checked={form.enabled}
                  onCheckedChange={(checked) => update("enabled", checked)}
                />
                <FieldLabel htmlFor={fieldId("enabled")}>启用连接</FieldLabel>
              </Field>
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <CardFooter className="mt-4 flex-wrap justify-between gap-3 border-t px-0 pt-5">
          <span
            role={failed ? "alert" : "status"}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            {busy && <LoaderCircle className="size-3 animate-spin" />}
            {busy ? "处理中…" : message}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={
                busy ||
                !form.enabled ||
                !form.modelName ||
                (!provider.hasApiKey && !apiKey.trim())
              }
              onClick={() => void save(true)}
            >
              保存并测试
            </Button>
            <Button type="submit" disabled={busy}>
              保存
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
