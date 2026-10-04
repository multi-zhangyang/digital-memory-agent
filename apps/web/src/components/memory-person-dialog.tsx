"use client";
import { useEffect, useState } from "react";
import type { MemoryEntry, MemoryPerson } from "@memory/contracts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { api } from "@/lib/api";

export function MemoryPersonDialog({
  person,
  memories,
  initialIds,
  onClose,
  onSaved,
}: {
  person?: MemoryPerson;
  memories: MemoryEntry[];
  initialIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(person?.name || "");
  const [aliases, setAliases] = useState(person?.aliases?.join("、") || "");
  const [selected, setSelected] = useState(initialIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState(() => memories.filter((entry) => initialIds.includes(entry.id)));
  const [loading, setLoading] = useState(entries.length !== initialIds.length);
  useEffect(() => {
    const controller = new AbortController();
    const existing = memories.filter((entry) => initialIds.includes(entry.id));
    const missing = initialIds.filter((id) => !existing.some((entry) => entry.id === id));
    setEntries(existing);
    setLoading(missing.length > 0);
    if (missing.length) void api<{ memories: MemoryEntry[] }>("/memories/lookup", {
      method: "POST", body: JSON.stringify({ ids: missing }), signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setEntries([...existing, ...result.memories]);
      if (result.memories.length !== missing.length) setError("部分关联记忆已不存在，请刷新列表。");
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [initialIds, memories]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {person?.id ? "编辑人物与别名" : "确认人物关联"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const refs = (ids: string[]) =>
                entries
                  .filter((entry) => ids.includes(entry.id))
                  .map(({ id, version }) => ({ id, version }));
              await api(
                person?.id ? `/memory-people/${person.id}` : "/memory-people",
                {
                  method: person?.id ? "PATCH" : "POST",
                  body: JSON.stringify({
                    name: name.trim(),
                    aliases: aliases
                      .split(/[、,，\n]/)
                      .map((value) => value.trim())
                      .filter(Boolean),
                    version: person?.version,
                    entries: refs(selected),
                    unlink: person?.id
                      ? refs(initialIds.filter((id) => !selected.includes(id)))
                      : [],
                  }),
                },
              );
              onSaved();
              onClose();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "保存失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="person-name">人物称呼</FieldLabel>
              <Input
                id="person-name"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="person-aliases">已确认的别名</FieldLabel>
              <Input
                id="person-aliases"
                value={aliases}
                onChange={(event) => setAliases(event.target.value)}
                placeholder="以顿号分隔"
              />
            </Field>
            <FieldSet>
              <FieldLegend>关联记忆</FieldLegend>
              <FieldGroup className="max-h-60 overflow-y-auto">
                {entries.map((entry) => (
                  <Field key={entry.id} orientation="horizontal">
                    <Checkbox
                      id={"person-memory-" + entry.id}
                      checked={selected.includes(entry.id)}
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, entry.id]
                            : selected.filter((id) => id !== entry.id),
                        )
                      }
                    />
                    <FieldLabel htmlFor={"person-memory-" + entry.id}>
                      {entry.title} · {entry.occurredAt || "时间未确定"}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
            {error && (
              <Alert>
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={busy}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || loading || entries.length !== initialIds.length || !name.trim()}>
                确认关联
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
