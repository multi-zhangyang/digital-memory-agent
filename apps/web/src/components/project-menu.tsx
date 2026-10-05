"use client";

import {
  DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@memory/contracts";
import { FolderOpen, Plus } from "lucide-react";

export function ProjectMenu({ project, projects, onSelect, onOpenFolder, onCreate }: {
  project?: Project;
  projects: Project[];
  onSelect: (id: string) => void;
  onOpenFolder: () => void;
  onCreate: () => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger><FolderOpen />工作目录</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        <DropdownMenuRadioGroup value={project?.id || "default"} onValueChange={onSelect}>
          {projects.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id} aria-label={"打开项目 " + item.name}>
              <span className="truncate">{item.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onOpenFolder}><FolderOpen />打开本地文件夹</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCreate}><Plus />新建工作目录</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
