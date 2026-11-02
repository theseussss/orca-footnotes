import type { Orca } from "../../vendor/orca";
import { createWorkspaceUI } from "../vnext/workspace";
import { sectionKind } from "./model";
import { SPECIAL_PAGES } from "./store";
import type { FootnoteController } from "./controller";

/** The footer section (and the recycle/archive pages): a read-only header row
 * drawn by us, children are ordinary native blocks. A non-empty, non-editable
 * header keeps Backspace at the first entry from merging into it. */
export function createSectionRenderer(React: typeof import("react"), api: Orca, controller: FootnoteController) {
  const { BlockShell, BlockChildren, Button, ContextMenu, MenuText } = api.components;
  const ui = createWorkspaceUI(React, api.components);
  const menuContainer = { current: document.body };
  const keep = { onMouseDown: (event: import("react").MouseEvent<HTMLElement>) => event.preventDefault() };
  return function Section(props: any) {
    React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const block = api.state.blocks[props.mirrorId ?? props.blockId], kind = sectionKind(block);
    const view = kind === "footer" && props.renderingMode !== "simple" ? controller.viewOfSection(props.blockId) : undefined;
    const actions = view ? controller.actionsOfSection(props.blockId) : undefined;
    const title = kind === "recycle" || kind === "archive" ? SPECIAL_PAGES[kind] : view?.preferences.title ?? "尾注";
    const heading = view?.preferences.footerStyle === "heading" || kind !== "footer";
    const header = <div className="ofn-v3-section-header" data-ofn-section={kind ?? "unknown"}>
      {heading ? <span className="ofn-v3-section-title">{title}</span> : <span className="ofn-v3-section-rule" role="separator" aria-label={title} />}
      {kind === "footer" && !view && props.renderingMode !== "simple" && <span className="ofn-v3-section-note">加载中…</span>}
      {kind === "archive" && <span className="ofn-v3-section-note">{controller.archiveDays() ? `保留 ${controller.archiveDays()} 天后清理` : "不自动清理"}</span>}
      {view && actions && <span className="ofn-v3-section-tools">
        <ui.ScopePicker view={view} actions={actions} />
        <ContextMenu container={menuContainer} noPointerLogic menuAttr={keep} menu={close => <>
          <MenuText title="复制归集全文 Markdown" preIcon="ti ti-copy" onClick={() => { close(); actions.copyDocument(); }} />
          <MenuText title="收集引文" preIcon="ti ti-plus" onClick={() => { close(); actions.create(); }} />
          <MenuText title="按编号整理" preIcon="ti ti-sort-ascending-numbers" onClick={() => { close(); controller.tidySection(props.blockId); }} />
          <MenuText title="回收站" preIcon="ti ti-trash" onClick={() => { close(); controller.openBin(); }} />
        </>}>
          {open => <Button type="button" variant="plain" className="ofn-next-button" aria-label="文末尾注操作" title="文末尾注操作" onMouseDown={keep.onMouseDown} onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>}
        </ContextMenu>
      </span>}
    </div>;
    return <BlockShell {...props} reprClassName={`ofn-v3-section ofn-v3-section-${kind ?? "unknown"}`} contentAttrs={{ contentEditable: false }}
      contentJsx={header}
      childrenJsx={<BlockChildren blockId={props.blockId} panelId={props.panelId} blockLevel={props.blockLevel} indentLevel={props.indentLevel} renderingMode={props.renderingMode} />} />;
  };
}
