export interface ProjectDocument {
  path: string;
  content: string | null;
  hash: string;
  size: number;
}
interface EditorDraft {
  document: ProjectDocument;
  content: string;
}
// Unsaved edits survive pane changes within this tab. File contents stay out of browser storage.
const drafts = new Map<string, EditorDraft>();
let unloadBound = false;
export const readEditorDraft = (projectId: string) => drafts.get(projectId);
export function saveEditorDraft(projectId: string, draft?: EditorDraft) {
  if (draft && draft.content !== draft.document.content)
    drafts.set(projectId, draft);
  else drafts.delete(projectId);
  if (!unloadBound && typeof window !== "undefined") {
    unloadBound = true;
    window.addEventListener("beforeunload", (event) => {
      if (!drafts.size) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
}
