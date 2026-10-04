"use client";
import { useEffect, useState } from "react";
import type { MemorySettings, ModelInfo } from "@memory/contracts";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";

export function MemorySettingsPanel({ models }: { models: ModelInfo[] }) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ settings: MemorySettings }>("/memory-settings", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSettings(value.settings);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <div className="flex flex-col gap-6">
      <h2>个人记忆</h2>
      {error && (
        <Alert>
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      {settings ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              const result = await api<{ settings: MemorySettings }>(
                "/memory-settings",
                { method: "PATCH", body: JSON.stringify({ ...settings, processingVersion: undefined }) },
              );
              setSettings(result.settings);
              setSaved(true);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "保存失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="memory-intake">新资料自动整理</FieldLabel>
              <Switch id="memory-intake" checked={settings.intake === "automatic"} onCheckedChange={(checked) => { setSettings({ ...settings, intake: checked ? "automatic" : "manual" }); setSaved(false); }} />
            </Field>
            {([
              ["automaticText", "自动处理文字"], ["automaticPhotos", "自动处理照片"], ["automaticVideos", "自动处理视频"], ["indexAssets", "维护本地资料索引"],
            ] as const).map(([key, label]) => <Field orientation="horizontal" key={key}>
              <FieldLabel htmlFor={"memory-" + key}>{label}</FieldLabel><Switch id={"memory-" + key} checked={key === "automaticVideos" ? settings[key] === true : settings[key] !== false}
                onCheckedChange={(checked) => { setSettings({ ...settings, [key]: checked }); setSaved(false); }} />
            </Field>)}
            {([
              ["textModelId", "文字处理模型"], ["datasetModelId", "数据集问题生成模型"], ["datasetReviewModelId", "数据集核验模型"],
            ] as const).map(([key, label]) => <Field key={key}>
              <FieldLabel htmlFor={"memory-" + key}>{label}</FieldLabel>
              <Select value={settings[key] || "auto"} onValueChange={(value) => { setSettings({ ...settings, [key]: value === "auto" ? "" : value }); setSaved(false); }}>
                <SelectTrigger id={"memory-" + key}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="auto">按任务模型或可用连接选择</SelectItem>
                  {settings[key] && !models.some((model) => model.id === settings[key]) && <SelectItem value={settings[key]!} disabled>当前模型未配置</SelectItem>}
                  {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </Field>)}
            <Field>
              <FieldLabel htmlFor="memory-photo-model">照片处理模型</FieldLabel>
              <Select value={settings.photoModelId || "auto"} onValueChange={(value) => {
                setSettings({ ...settings, photoModelId: value === "auto" ? "" : value });
                setSaved(false);
              }}>
                <SelectTrigger id="memory-photo-model"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="auto">自动选择</SelectItem>
                  {settings.photoModelId && !models.some((model) => model.id === settings.photoModelId && model.supportsImages) &&
                    <SelectItem value={settings.photoModelId} disabled>当前模型未配置</SelectItem>}
                  {models.filter((model) => model.supportsImages).map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="memory-video-model">视频画面处理模型</FieldLabel>
              <Select value={settings.videoModelId || "auto"} onValueChange={(value) => { setSettings({ ...settings, videoModelId: value === "auto" ? "" : value }); setSaved(false); }}>
                <SelectTrigger id="memory-video-model"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="auto">沿用照片处理模型</SelectItem>
                  {settings.videoModelId && !models.some((model) => model.id === settings.videoModelId && model.supportsImages) && <SelectItem value={settings.videoModelId} disabled>当前模型未配置</SelectItem>}
                  {models.filter((model) => model.supportsImages).map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="memory-video-interval">视频画面间隔（秒）</FieldLabel>
              <Input id="memory-video-interval" type="number" min={1} max={120} step={1} value={settings.videoSampleInterval ?? 10}
                onChange={(event) => { setSettings({ ...settings, videoSampleInterval: Number(event.target.value) }); setSaved(false); }} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="memory-auto-capture">
                自动记录我的明确陈述
              </FieldLabel>
              <Switch
                id="memory-auto-capture"
                checked={settings.capture === "graded"}
                onCheckedChange={(checked) => {
                  setSettings({
                    ...settings,
                    capture: checked ? "graded" : "off",
                  });
                  setSaved(false);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="memory-timezone">经历记录时区</FieldLabel>
              <Input
                id="memory-timezone"
                value={settings.timeZone}
                onChange={(event) => {
                  setSettings({ ...settings, timeZone: event.target.value });
                  setSaved(false);
                }}
              />
            </Field>
            <Field orientation="horizontal">
              <Button type="submit" disabled={busy}>
                {busy ? "保存中" : saved ? "已保存" : "保存记忆设置"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      ) : (
        !error && <Skeleton className="h-32 w-full" />
      )}
    </div>
  );
}
