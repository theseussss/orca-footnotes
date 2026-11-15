import type { Orca } from "../../vendor/orca";
import { createWorkspaceUI } from "../vnext/workspace";
import { sectionKind } from "./model";
import { SPECIAL_PAGES } from "./store";
import type { FootnoteController } from "./controller";

/** Set around the footer drawn inside the 尾注 tab. */
let InTab: import("react").Context<boolean> | undefined;
const inTabContext = (React: typeof import("react")) => InTab ??= React.createContext(false);

/** The footer section (and the recycle/archive pages): a read-only header row
 * drawn by us, children are ordinary native blocks. A non-empty, non-editable
 * header keeps Backspace at the first entry from merging into it.
 * When the footer lives in the 尾注 tab, the copy at the end of the body draws
 * it there through a portal: the same block, with Orca's editor around it, so
 * editing works as in the body. Without bottom tabs (hover previews), when
 * exporting, or with the setting 正文末尾, it is drawn in the body. */
export function createSectionRenderer(React: typeof import("react"), api: Orca, controller: FootnoteController) {
  const { BlockShell, BlockChildren, Block, Button, ContextMenu, MenuText } = api.components;
  const ui = createWorkspaceUI(React, api.components);
  const menuContainer = { current: document.body };
  const keep = { onMouseDown: (event: import("react").MouseEvent<HTMLElement>) => event.preventDefault() };
  const TabContext = inTabContext(React);
  const createPortal = (window as any).ReactDOM.createPortal as (node: import("react").ReactNode, target: Element) => import("react").ReactElement;
  return function Section(props: any) {
    React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const inTab = React.useContext(TabContext), editorContext = React.useContext(api.contexts.BlockEditorContext) as any;
    const block = api.state.blocks[props.mirrorId ?? props.blockId], kind = sectionKind(block);
    // The view root's own footer, outside the tab, while the footer belongs in the tab.
    const wantsTab = kind === "footer" && !inTab && props.renderingMode !== "simple" && controller.placement() === "tab";
    // undefined: not known yet (first frame) — draw nothing rather than flash the footer in the body.
    const [mount, setMount] = React.useState<HTMLElement | null | undefined>(undefined);
    React.useLayoutEffect(() => {
      if (!wantsTab) { if (mount !== undefined) setMount(undefined); return; }
      const editor: HTMLElement | null | undefined = editorContext?.editor?.current;
      const own = !!editor && Number(editor.dataset.blockId) === block?.parent;
      const next = own ? controller.tabMount(editor) ?? null : null;
      if (next !== mount) setMount(next);
    });
    if (wantsTab && mount === undefined) return null;
    if (wantsTab && mount) return createPortal(<TabContext.Provider value={true}>
      <Block panelId={props.panelId} blockId={props.blockId} blockLevel={0} indentLevel={0} />
    </TabContext.Provider>, mount);
    const view = kind === "footer" && props.renderingMode !== "simple" ? controller.viewOfSection(props.blockId) : undefined;
    const actions = view ? controller.actionsOfSection(props.blockId) : undefined;
    const title = kind === "recycle" || kind === "archive" ? SPECIAL_PAGES[kind] : view?.preferences.title ?? "尾注";
    const heading = view?.preferences.footerStyle === "heading" || kind !== "footer";
    const header = <div className="ofn-v3-section-header" data-ofn-section={kind ?? "unknown"}>
      {inTab ? <span className="ofn-v3-section-fill" /> : heading ? <span className="ofn-v3-section-title">{title}</span> : <span className="ofn-v3-section-rule" role="separator" aria-label={title} />}
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
    return <BlockShell {...props} reprClassName={`ofn-v3-section ofn-v3-section-${kind ?? "unknown"}${inTab ? " ofn-v3-section-in-tab" : ""}`} contentAttrs={{ contentEditable: false }}
      contentJsx={header}
      childrenJsx={<BlockChildren blockId={props.blockId} panelId={props.panelId} blockLevel={props.blockLevel} indentLevel={props.indentLevel} renderingMode={props.renderingMode} />} />;
  };
}
