import type { DbId } from "../../vendor/orca";
import type { AnnotationItem, AnnotationState } from "./domain";

export interface AnnotationRecord extends AnnotationItem {
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recycledAt?: number;
  readonly archivedAt?: number;
}
export interface HistoryVersion {
  readonly revision: number;
  readonly at: number;
  readonly text: string;
  readonly comment: string;
  readonly reason: "save" | "restore" | "recycle" | "recover";
}
export interface AnnotationDraft {
  readonly itemId: DbId;
  readonly baseRevision: number;
  readonly text: string;
  readonly comment: string;
  readonly at: number;
}
export interface DurableValues {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface ContentSave {
  readonly itemId: DbId;
  readonly baseRevision: number;
  readonly text: string;
  readonly comment: string;
}
export type SaveState = "saved" | "saving" | "pending" | "error";
export interface EditorSnapshot {
  readonly itemId: DbId;
  readonly text: string;
  readonly comment: string;
  readonly revision: number;
  readonly state: SaveState;
  readonly error?: string;
  readonly recovered: boolean;
}
export interface ScopePreferences {
  readonly version: 1;
  readonly roots: readonly DbId[];
  /** Retained for preview.1 preference compatibility; no longer exclusive layout. */
  readonly placement: "bottom" | "right";
  readonly navigatorVisible?: boolean;
  readonly footerVisible?: boolean;
  readonly directoryClick?: "body" | "footer";
  /** Empty disables the optional direct-input trigger. Never consumes native @. */
  readonly triggerSymbol?: string;
  readonly footerStyle: "rule" | "heading";
  readonly title: string;
  readonly excerptLength: number;
  readonly locationMode: "choose" | "highlight";
  readonly historyLimit: number;
  /** null disables physical automatic purge; UI can explicitly choose a retention. */
  readonly archiveDays: number | null;
}
export const DEFAULT_PREFERENCES: ScopePreferences = Object.freeze({
  version: 1, roots: [], placement: "bottom", navigatorVisible: true, footerVisible: true, directoryClick: "body", triggerSymbol: "", footerStyle: "rule", title: "尾注",
  excerptLength: 100, locationMode: "choose", historyLimit: 40, archiveDays: null,
});
export interface AnnotationMetadata {
  readonly version: 1;
  readonly ownerRootId: DbId;
  readonly state: AnnotationState;
  readonly comment: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recycledAt?: number;
  readonly archivedAt?: number;
}
export const ITEM_PROPERTY = "orca-footnotes.annotation";
export const STORE_PROPERTY = "orca-footnotes.annotation-store";
export const ITEM_REPR = "orca-footnotes.annotation";
export const STORE_REPR = "orca-footnotes.annotation-store";
