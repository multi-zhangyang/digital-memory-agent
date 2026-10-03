"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortDate } from "@/lib/api";
import { downloadText } from "@/lib/workbench";
import type { Artifact } from "@memory/contracts";
import { ArrowUpRight, Download, FileText, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";

export function ArtifactLibrary({
  artifacts,
  onOpen,
  onStart,
}: {
  artifacts: Artifact[];
  onOpen: (id: string) => void;
  onStart: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());
  const filtered = artifacts
    .filter((item) =>
      (item.title + item.content).toLowerCase().includes(search),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-10 sm:px-10 lg:px-12">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-2xl font-medium tracking-tight">
            整理结果<Badge variant="secondary">{artifacts.length}</Badge>
          </h1>
          <Button variant="outline" size="sm" onClick={onStart}>
            新任务
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
        <div className="mb-6 mt-8 border-b pb-5">
          <InputGroup className="max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="搜索整理结果"
              placeholder="搜索结果"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
        </div>
        {filtered.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文档</TableHead>
                <TableHead className="hidden sm:table-cell">更新日期</TableHead>
                <TableHead>版本</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-0">
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start gap-3 px-1 py-3 text-left"
                      onClick={() => onOpen(item.id)}
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {item.title}
                        </span>
                        <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                          {item.content
                            .replace(/[#*`]/g, "")
                            .trim()
                            .slice(0, 120)}
                        </span>
                      </span>
                    </Button>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {shortDate(item.updatedAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    v{item.version}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={"下载 " + item.title}
                      onClick={() => downloadText(item.title, item.content)}
                    >
                      <Download className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty className="min-h-80">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>
                {query ? "没有匹配的结果" : "还没有整理结果"}
              </EmptyTitle>
            </EmptyHeader>
            {!query && (
              <EmptyContent>
                <Button variant="outline" onClick={onStart}>
                  开始任务
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}
