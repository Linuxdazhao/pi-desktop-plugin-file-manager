/**
 * CodeMirror 6 编辑器。
 *
 * 不用 codemirror 的 basicSetup：它内部注册了
 * `syntaxHighlighting(defaultHighlightStyle, { fallback: true })`，
 * 与自己的 HighlightStyle 形成两个 fallback 高亮器，谁生效并不确定——
 * 这正是「代码没有高亮」的根因。这里改为显式组装扩展列表，
 * 高亮器只有一个，来自 ./highlight（与 Markdown 预览共用）。
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

import type { Base } from "./appearance";
import { highlightExtension } from "./highlight";
import { resolveLanguage } from "./languages";

const languageSlot = new Compartment();
const highlightSlot = new Compartment();
const readOnlySlot = new Compartment();

type EditorOptions = { base: Base; onDocChanged: () => void; onSave: () => void };
// A snapshot may outlive its original view. Its extensions must not retain that
// view's React callbacks (or send a save/dirty notification to the wrong pane).
const handlers = new WeakMap<EditorView, EditorOptions>();
const readOnlyExtensions = (value: boolean) =>
  value ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];

function baseExtensions(base: Base, readOnly = false, language: Extension = []): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([
      { key: "Mod-s", preventDefault: true, run(view) { handlers.get(view)?.onSave(); return true; } },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) handlers.get(update.view)?.onDocChanged();
    }),
    readOnlySlot.of(readOnlyExtensions(readOnly)),
    languageSlot.of(language),
    highlightSlot.of(highlightExtension(base)),
  ];
}

/** Immutable draft, selection and undo history; no text copy on tab switches. */
export type TabEditorSnapshot = {
  readonly state: EditorState;
  readonly scroll: ReturnType<EditorView["scrollSnapshot"]>;
};

export type EditorHandle = {
  view: EditorView;
  capture(): TabEditorSnapshot;
  setDocument(text: string, filePath: string, readOnly: boolean, restore?: TabEditorSnapshot): void;
  destroy(): void;
  setBase(base: Base): void;
  setReadOnly(readOnly: boolean): void;
  text(): string;
};

export function createEditor(
  parent: HTMLElement,
  options: EditorOptions,
): EditorHandle {
  let base = options.base;
  let languageToken = 0;
  const view = new EditorView({ parent, state: EditorState.create({ extensions: baseExtensions(base) }) });
  handlers.set(view, options);

  // display:none (structured/Git preview) reports zero scroll offsets. Keep
  // the last visible position for a tab switch initiated from such a preview.
  let lastScroll = view.scrollSnapshot();
  let restoringScroll = false;
  const rememberScroll = () => {
    if (!restoringScroll && view.scrollDOM.clientHeight) lastScroll = view.scrollSnapshot();
  };
  view.scrollDOM.addEventListener("scroll", rememberScroll, { passive: true });

  return {
    view,
    text: () => view.state.doc.toString(),
    capture() {
      rememberScroll();
      return { state: view.state, scroll: lastScroll };
    },
    setBase(next) {
      base = next;
      view.dispatch({ effects: highlightSlot.reconfigure(highlightExtension(base)) });
    },
    setReadOnly(value) {
      view.dispatch({ effects: readOnlySlot.reconfigure(readOnlyExtensions(value)) });
    },
    setDocument(text, filePath, readOnly, restore) {
      const token = ++languageToken;
      const description = resolveLanguage(filePath);
      const language = description?.support ?? [];
      // setState is a document switch, not a replacement edit. A fresh load
      // starts with empty history; a tab restore keeps its own history fields.
      const state = restore ? restore.state.update({ effects: [
        highlightSlot.reconfigure(highlightExtension(base)),
        readOnlySlot.reconfigure(readOnlyExtensions(readOnly)),
        languageSlot.reconfigure(language),
      ] }).state : EditorState.create({ doc: text, extensions: baseExtensions(base, readOnly, language) });
      view.setState(state);
      restoringScroll = Boolean(restore);
      if (restore) {
        lastScroll = restore.scroll;
        view.dispatch({ effects: restore.scroll });
        // CodeMirror applies scroll effects during measurement. Switching away
        // again before that frame must capture the incoming tab's own anchor.
        view.requestMeasure({ read() {}, write() { if (token === languageToken) restoringScroll = false; } });
      } else {
        view.scrollDOM.scrollTo(0, 0);
        lastScroll = view.scrollSnapshot();
      }

      if (description && !description.support) void description.load().then(support => {
        if (token === languageToken) view.dispatch({ effects: languageSlot.reconfigure(support) });
      });
    },
    destroy() {
      languageToken++;
      view.scrollDOM.removeEventListener("scroll", rememberScroll);
      handlers.delete(view);
      view.destroy();
    },
  };
}
