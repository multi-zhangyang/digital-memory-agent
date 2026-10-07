"use client";

import { useEffect, useState } from "react";
import type { FeatureChannel, FeatureConnectionStatus, FeatureConnectionUpdate, FeatureModelConfiguration, MemoryFeatureStatus } from "@memory/contracts";
import { api } from "@/lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";

const labels = { text: "文字嵌入", image: "图像嵌入", face: "人脸特征" };
type Configuration = FeatureModelConfiguration & { status: MemoryFeatureStatus };

export function FeatureModelSettings() {
  const [configuration, setConfiguration] = useState<FeatureModelConfiguration>();
  const [status, setStatus] = useState<MemoryFeatureStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Configuration>("/settings/features").then((value) => {
      if (active) { setConfiguration(value); setStatus(value.status); }
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    const timer = setInterval(() => {
      api<Configuration>("/settings/features").then((value) => { if (active) setStatus(value.status); }).catch(() => {});
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <Card className="mt-8" data-testid="feature-model-settings">
    <CardHeader>
      <CardTitle>检索与人物服务</CardTitle>
      <CardDescription>连接你选择的本地或远端服务。启用后，服务会接收对应的文字或图片；图像与人脸能力可独立配置，也可接入同一服务。</CardDescription>
      {status && <Badge variant="outline">{({ not_configured: "未启用", starting: "正在连接", ready: "服务已连接", unavailable: "服务不可用" })[status.state]}</Badge>}
    </CardHeader>
    <CardContent>
      {error && <Alert variant="destructive"><AlertTitle>读取配置失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!configuration && !error && <Spinner aria-label="加载服务配置" />}
      {configuration && <Accordion type="multiple">
        {(["text", "image", "face"] as const).map((channel) => <AccordionItem key={channel} value={channel}>
          <AccordionTrigger><span>{labels[channel]}</span><Badge variant="outline">{configuration.connections[channel].enabled ? "已启用" : "未启用"}</Badge></AccordionTrigger>
          <AccordionContent>
            <ConnectionForm channel={channel} connection={configuration.connections[channel]} onSaved={setConfiguration} />
          </AccordionContent>
        </AccordionItem>)}
      </Accordion>}
    </CardContent>
    {configuration && <CardFooter><FacePolicy configuration={configuration} onSaved={setConfiguration} /></CardFooter>}
  </Card>;
}

function values(connection: FeatureConnectionStatus): FeatureConnectionUpdate {
  const { hasApiKey: _, ...settings } = connection;
  return { ...settings, apiKey: "", clearApiKey: false };
}

function ConnectionForm({ channel, connection, onSaved }: {
  channel: FeatureChannel; connection: FeatureConnectionStatus; onSaved: (value: FeatureModelConfiguration) => void;
}) {
  const [form, setForm] = useState(() => values(connection));
  const [busy, setBusy] = useState<"save" | "test">();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const fieldId = (name: string) => `feature-${channel}-${name}`;
  const change = <K extends keyof FeatureConnectionUpdate>(key: K, value: FeatureConnectionUpdate[K]) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(action: "save" | "test") {
    setBusy(action); setMessage(""); setFailed(false);
    try {
      if (action === "test") {
        const result = await api<{ model: { dimensions: number } }>(`/settings/features/${channel}/test`, { method: "POST", body: JSON.stringify(form) });
        setMessage(`接口验证通过 · ${result.model.dimensions} 维。配置尚未保存。`);
      } else {
        const next = await api<FeatureModelConfiguration>(`/settings/features/${channel}`, { method: "POST", body: JSON.stringify(form) });
        setForm(values(next.connections[channel])); onSaved(next);
        setMessage(next.connections[channel].enabled ? "已保存并应用，后台正在准备索引。" : "已保存，服务已停用。");
      }
    } catch (failure) { setFailed(true); setMessage(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(undefined); }
  }
  return <form onSubmit={(event) => { event.preventDefault(); void submit("save"); }}>
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldLabel htmlFor={fieldId("enabled")}>启用{labels[channel]}</FieldLabel>
        <Switch id={fieldId("enabled")} checked={form.enabled} onCheckedChange={(v) => change("enabled", v)} disabled={!!busy} />
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldId("protocol")}>接口协议</FieldLabel>
        <Select value={form.protocol} onValueChange={(v) => change("protocol", v as FeatureConnectionUpdate["protocol"])} disabled={!!busy}>
          <SelectTrigger id={fieldId("protocol")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            {channel === "text" && <SelectItem value="openai-embeddings">OpenAI 兼容 Embeddings</SelectItem>}
            <SelectItem value="memory-features-v1">Memory Features v1</SelectItem>
          </SelectGroup></SelectContent>
        </Select>
        {channel !== "text" && <FieldDescription>服务需实现 Memory Features v1 的{channel === "image" ? "图片编码和文字找图" : "人脸检测与特征提取"}接口。</FieldDescription>}
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldId("url")}>服务地址</FieldLabel>
        <Input id={fieldId("url")} value={form.baseUrl} onChange={(e) => change("baseUrl", e.target.value)} disabled={!!busy} autoComplete="off" />
        <FieldDescription>{form.protocol === "openai-embeddings" ? "填写 API 基础地址，系统会追加 /embeddings。" : "填写完整的 POST 接口地址。"}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldId("model")}>模型名称</FieldLabel>
        <Input id={fieldId("model")} value={form.modelName} onChange={(e) => change("modelName", e.target.value)} disabled={!!busy} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldId("revision")}>版本标记</FieldLabel>
        <Input id={fieldId("revision")} value={form.revision} onChange={(e) => change("revision", e.target.value)} disabled={!!busy} />
        <FieldDescription>同名模型更换权重或编码方式后，请更新此标记，以重新建立索引。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={fieldId("key")}>API 密钥</FieldLabel>
        <Input id={fieldId("key")} type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => change("apiKey", e.target.value)} disabled={!!busy || form.clearApiKey}
          placeholder={connection.hasApiKey ? "已保存；留空保留" : "无需认证可留空"} />
        <FieldDescription>更换服务地址后，需要重新填写密钥。</FieldDescription>
      </Field>
      {connection.hasApiKey && <Field orientation="horizontal">
        <FieldLabel htmlFor={fieldId("clear-key")}>清除已保存密钥</FieldLabel>
        <Switch id={fieldId("clear-key")} checked={form.clearApiKey} onCheckedChange={(v) => change("clearApiKey", v)} disabled={!!busy} />
      </Field>}
      <Field orientation="horizontal">
        <Button type="submit" disabled={!!busy}>{busy === "save" && <Spinner data-icon="inline-start" />}保存</Button>
        <Button type="button" variant="outline" disabled={!!busy} onClick={() => void submit("test")}>{busy === "test" && <Spinner data-icon="inline-start" />}测试连接</Button>
      </Field>
      {message && <Alert variant={failed ? "destructive" : "default"} role="status"><AlertTitle>{message}</AlertTitle></Alert>}
    </FieldGroup>
  </form>;
}

function FacePolicy({ configuration, onSaved }: { configuration: FeatureModelConfiguration; onSaved: (value: FeatureModelConfiguration) => void }) {
  const [threshold, setThreshold] = useState(String(configuration.faceMatchThreshold));
  const [margin, setMargin] = useState(String(configuration.faceMatchMargin));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  return <form className="w-full" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      onSaved(await api<FeatureModelConfiguration>("/settings/features/policy", { method: "POST", body: JSON.stringify({ faceMatchThreshold: Number(threshold), faceMatchMargin: Number(margin) }) }));
      setMessage("候选匹配参数已保存。");
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setBusy(false); }
  }}>
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="face-match-threshold">人物候选相似度阈值</FieldLabel>
        <Input id="face-match-threshold" type="number" min="0" max="1" step="0.01" required value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={busy} />
        <FieldDescription>按所用人脸模型调整。达到阈值只产生候选关联，真实身份仍需可靠依据。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="face-match-margin">与次优候选的最小差值</FieldLabel>
        <Input id="face-match-margin" type="number" min="0" max="1" step="0.01" required value={margin} onChange={(e) => setMargin(e.target.value)} disabled={busy} />
      </Field>
      <Field><Button type="submit" variant="outline" disabled={busy}>{busy && <Spinner data-icon="inline-start" />}保存匹配参数</Button></Field>
      {message && <Alert role="status"><AlertTitle>{message}</AlertTitle></Alert>}
    </FieldGroup>
  </form>;
}
