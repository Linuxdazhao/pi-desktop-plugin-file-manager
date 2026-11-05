import type { EditorState } from "@codemirror/state";

export const FILE_LINES_CLIPBOARD_TYPE = "application/x-pi-desktop-file-lines";

export type FileLineReference = {
  workspace: string;
  path: string;
  start: number;
  end: number;
};

export function readFileLineSelection(state: EditorState, workspace: string, path: string): FileLineReference | null {
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) return null;
  const { from, to } = state.selection.main;
  return {
    workspace,
    path,
    start: state.doc.lineAt(from).number,
    end: state.doc.lineAt(to - 1).number,
  };
}
