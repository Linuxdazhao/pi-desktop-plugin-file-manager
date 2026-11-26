import { useReducer } from "react";
import type { HistoryCommit } from "../components/GitHistory";
import type { GitSelection, GitScope } from "./gitWorkspace";

export type ReviewTab = ({ kind: "diff"; panel: boolean } & GitSelection) | { kind: "commit"; commit: HistoryCommit };
export const reviewKey = (tab: ReviewTab) => tab.kind === "diff" ? `diff:${tab.path}` : `commit:${tab.commit.oid}`;

type State = { tabs: ReviewTab[]; active: string | null };
type Action = { type: "open"; tab: ReviewTab } | { type: "activate" | "close"; key: string } |
  { type: "scope"; key: string; scope: GitScope } | { type: "document" | "clear" };
const empty: State = { tabs: [], active: null };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "clear": return empty;
    case "document": return state.active === null ? state : { ...state, active: null };
    case "activate": return { ...state, active: action.key };
    case "open": {
      const key = reviewKey(action.tab);
      const i = state.tabs.findIndex(tab => reviewKey(tab) === key);
      const tabs = i < 0 ? [...state.tabs, action.tab] : state.tabs.map((tab, index) => index === i ? action.tab : tab);
      return { tabs, active: key };
    }
    case "close": {
      const i = state.tabs.findIndex(tab => reviewKey(tab) === action.key);
      if (i < 0) return state;
      const tabs = state.tabs.filter((_, index) => index !== i);
      const neighbor = tabs[i] ?? tabs[i - 1];
      return { tabs, active: state.active === action.key ? (neighbor ? reviewKey(neighbor) : null) : state.active };
    }
    case "scope": return { ...state, tabs: state.tabs.map(tab => tab.kind === "diff" && reviewKey(tab) === action.key ? { ...tab, scope: action.scope } : tab) };
  }
}

export function useReviewTabs() {
  return useReducer(reducer, empty);
}
