import type { DbId } from "../../vendor/orca";
import type { AnnotationRecord, EditorSnapshot, HistoryVersion, ScopePreferences } from "./types";
import type { InsertionDraftSnapshot } from "./insertion-draft";
import type { DirectoryLayout } from "./directory-layout";
import type { AnnotationViewRecord } from "./content-view";
export interface WorkspaceItem {
  readonly item: AnnotationViewRecord;
  readonly number?: number;
  readonly referenceCount: number;
  /** Distinct native source blocks, not an inferred count of Orca "pages". */
  readonly pageCount: number;
}
export interface LocationView {
  readonly key: string;
  readonly blockId: DbId;
  readonly number: number;
  readonly excerpt: string;
  readonly pageLabel: string;
}
export interface WorkspaceView {
  readonly loading: boolean;
  readonly error?: string;
  readonly sourceLabel: string;
  readonly sourceRootId?: DbId;
  readonly scopeRootId?: DbId;
  readonly scopeLabel: string;
  readonly inherited: boolean;
  readonly scopeOptions: readonly { id: DbId; label: string }[];
  readonly preferences: ScopePreferences;
  readonly directoryLayout?: DirectoryLayout;
  readonly footerDisplayed?: boolean;
  readonly entries: readonly WorkspaceItem[];
  readonly candidates: readonly WorkspaceItem[];
  readonly usedElsewhere?: readonly WorkspaceItem[];
  readonly recycled: readonly WorkspaceItem[];
  readonly archived: readonly WorkspaceItem[];
  readonly selectedItemId?: DbId;
  readonly selectingReference?: boolean;
  readonly selectedOccurrence?: { readonly blockId: DbId; readonly key: string };
  readonly editor?: { item: AnnotationRecord; draft: EditorSnapshot; history: readonly HistoryVersion[]; readonly closing?: boolean; readonly sessionId?: number; readonly scopeLabel?: string; readonly canRemoveOccurrence?: boolean };
  readonly composer?: { readonly draft: InsertionDraftSnapshot; readonly sessionId: number; readonly candidateOnly: boolean; readonly closing: boolean; readonly items: readonly WorkspaceItem[] };
  readonly locations?: readonly LocationView[];
  readonly deletion?: { itemId: DbId; text: string; references: number; pages: number };
  readonly notice?: string;
}
export interface WorkspaceActions {
  select(id: DbId, rect?: DOMRect): void;
  closeNavigator(): void;
  toggleDirectoryLock(): void;
  resetDirectoryPosition(): void;
  toggleFooter(): void;
  directoryClick(value: "body" | "footer"): void;
  changeInput(text: string, comment: string): void;
  confirmInput(itemId?: DbId): void;
  cancelInput(): void;
  retryInput(): void;
  backToList(): void;
  pickReference(): void;
  cancelPickReference(): void;
  removeSelectedOccurrence(): void;
  navigatorVisible(value: boolean): void;
  footerVisible(value: boolean): void;
  create(): void;
  edit(id: DbId, rect?: DOMRect): void;
  use(id: DbId): void;
  hover(id: DbId | null): void;
  /** Preview exactly one currently loaded body occurrence; never navigate. */
  hoverOccurrence(key: string | null): void;
  locate(id: DbId, rect?: DOMRect): void;
  recycle(id: DbId): void;
  confirmRecycle(): void;
  cancelRecycle(): void;
  archive(id: DbId): void;
  recover(id: DbId): void;
  purgeExpired(): void;
  scope(id: DbId | null): void;
  placement(value: ScopePreferences["placement"]): void;
  footerStyle(value: ScopePreferences["footerStyle"]): void;
  locationMode(value: ScopePreferences["locationMode"]): void;
  excerptLength(value: number): void;
  archiveDays(value: number | null): void;
  changeDraft(text: string, comment: string): void;
  closeEditor(): void;
  restoreHistory(revision: number): void;
  chooseLocation(key: string): void;
  closeLocations(): void;
  copyItem(id: DbId): void;
  copyDocument(): void;
  importLegacy(): void;
  manage(): void;
}
