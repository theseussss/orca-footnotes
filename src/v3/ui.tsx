import type { ReactNode } from "react";
import type { DbId, Orca } from "../../vendor/orca";
import type { WorkspaceActions, WorkspaceItem, WorkspaceView } from "../vnext/ui-contract";

type Components = Pick<Orca["components"], "Button" | "MenuText" | "ContextMenu" | "MenuSeparator" | "MenuTitle">;
const textOf = (row: WorkspaceItem): string => "text" in row.item ? String((row.item as { text: string }).text) : "";

/** One row of the inline footnote popup. */
export type InputOption =
  | { readonly kind: "new"; readonly text: string }
  | { readonly kind: "note"; readonly id: DbId; readonly text: string; readonly hint: string; readonly here: boolean }
  | { readonly kind: "material"; readonly id: DbId; readonly text: string; readonly hint: string };

/** Candidates while typing a footnote in the body. Never takes focus: the
 * caret stays in the body; keys are read by the controller. */
export function createInputPopup(React: typeof import("react"), components: Components) {
  const { MenuText, MenuSeparator, MenuTitle } = components;
  // Rows above the first rule are this range's; below are other pages' footnotes, then material.
  const group = (option: InputOption) => option.kind === "material" ? "material" : option.kind === "note" && !option.here ? "elsewhere" : "here";
  const titles = { elsewhere: "别处的尾注", material: "库里的资料" } as const;
  return function InputPopup({ rect, options, selected, busy, onChoose }: { rect?: DOMRect; options: readonly InputOption[];
    selected: number; busy: boolean; onChoose: (index: number) => void }) {
    const list = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => { list.current?.querySelector<HTMLElement>(".orca-key-selected")?.scrollIntoView({ block: "nearest" }); }, [selected]);
    const top = Math.min((rect?.bottom ?? 120) + 6, window.innerHeight - 40), left = Math.max(8, Math.min(rect?.left ?? 120, window.innerWidth - 360));
    return <div ref={list} data-ofn-input-popup="" className="orca-menu ofn-v3-input" style={{ position: "fixed", top, left, zIndex: 1000 }}
      onMouseDown={event => event.preventDefault()} role="listbox" aria-label="尾注候选" aria-busy={busy}>
      {options.map((option, index) => { const kind = group(option), head = kind !== "here" && (index === 0 || group(options[index - 1]) !== kind);
        return <React.Fragment key={option.kind === "new" ? "new" : `${option.kind}:${option.id}`}>
        {head && <><MenuSeparator /><MenuTitle title={titles[kind]} /></>}
        <MenuText
        title={option.kind === "new" ? option.text ? `新建尾注：${option.text}` : "新建尾注" : option.text || "（空）"}
        subtitle={option.kind === "new" ? undefined : option.hint || undefined}
        preIcon={option.kind === "new" ? "ti ti-plus" : option.kind === "note" ? "ti ti-quote" : "ti ti-cube"}
        className={index === selected ? "orca-key-selected" : ""} role="option" aria-selected={index === selected} onClick={() => onChoose(index)} />
        </React.Fragment>; })}
    </div>;
  };
}

/** The right-side directory: a quiet list in the host's popup surface. One line
 * per footnote, muted number, full text on hover; controls appear on hover. */
export function createDirectoryUI(React: typeof import("react"), components: Components) {
  const { Button, MenuText, ContextMenu } = components;
  const menuContainer = { current: document.body };
  const keep = { onMouseDown: (event: import("react").MouseEvent<HTMLElement>) => event.preventDefault() };
  const Tool = ({ icon, label, onClick, pressed }: { icon: string; label: string; onClick: (event: import("react").MouseEvent<HTMLButtonElement>) => void; pressed?: boolean }) =>
    <Button type="button" variant="plain" className="ofn-v3-tool" aria-label={label} title={label} aria-pressed={pressed} onMouseDown={keep.onMouseDown} onClick={onClick}><i className={`ti ${icon}`} aria-hidden="true" /></Button>;
  function Directory({ view, actions }: { view: WorkspaceView; actions: WorkspaceActions }) {
    const locked = view.directoryLayout?.locked === true;
    React.useEffect(() => () => actions.hover(null), []);
    return <section className="orca-menu ofn-v3-dir" aria-label="尾注目录" aria-busy={view.loading}>
      <header className="ofn-v3-dir-head" data-ofn-drag-handle="true" data-locked={String(locked)}>
        <span className="ofn-v3-dir-title" title={view.inherited ? `编号范围：${view.scopeLabel}` : undefined}>{view.inherited ? `尾注 · ${view.scopeLabel}` : "尾注"}</span>
        <span className="ofn-v3-dir-tools">
          <Tool icon={locked ? "ti-lock" : "ti-lock-open"} label={locked ? "解锁位置" : "锁定位置"} pressed={locked} onClick={() => actions.toggleDirectoryLock()} />
          <ContextMenu container={menuContainer} noPointerLogic menuAttr={keep} menu={close => <MenuText title="恢复默认位置" preIcon="ti ti-focus-centered" onClick={() => { close(); actions.resetDirectoryPosition(); }} />}>
            {open => <Tool icon="ti-dots" label="目录操作" onClick={open} />}
          </ContextMenu>
          <Tool icon="ti-x" label="关闭目录" onClick={() => actions.closeNavigator()} />
        </span>
      </header>
      {view.entries.length ? <ol className="ofn-v3-dir-list">{view.entries.map(row => {
        const text = textOf(row), selected = view.selectedItemId === row.item.id;
        return <li key={row.item.id} className={`ofn-v3-dir-row${selected ? " is-selected" : ""}`} data-item-id={row.item.id}
          onMouseEnter={() => actions.hover(row.item.id)} onMouseLeave={() => actions.hover(null)}>
          <ContextMenu container={menuContainer} noPointerLogic menuAttr={keep} menu={close => <>
            <MenuText title="编辑" preIcon="ti ti-pencil" onClick={() => { close(); actions.edit(row.item.id); }} />
            <MenuText title="引用此条" preIcon="ti ti-link" onClick={() => { close(); actions.use(row.item.id); }} />
            <MenuText title="正文引用" preIcon="ti ti-arrow-back-up" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); close(); actions.locate(row.item.id, rect); }} />
            <MenuText title="复制" preIcon="ti ti-copy" onClick={() => { close(); actions.copyItem(row.item.id); }} />
            <MenuText title="删除尾注" preIcon="ti ti-trash" dangerous onClick={() => { close(); actions.recycle(row.item.id); }} />
          </>}>
            {open => <>
              <button type="button" className="ofn-v3-dir-item" title={text} aria-current={selected ? "true" : undefined} aria-label={`尾注 ${row.number}：${text}`}
                onContextMenu={open} onClick={event => actions.select(row.item.id, event.currentTarget.getBoundingClientRect())}>
                <span className="ofn-v3-dir-num">{row.number}</span><span className="ofn-v3-dir-text">{text || "（空）"}</span>
              </button>
              <Button type="button" variant="plain" className="ofn-v3-tool ofn-v3-dir-more" aria-label={`尾注 ${row.number} 操作`} title="尾注操作" onMouseDown={keep.onMouseDown} onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>
            </>}
          </ContextMenu>
        </li>; })}</ol> : <div className="ofn-v3-dir-empty">{view.loading ? "加载中…" : "暂无尾注"}</div>}
    </section>;
  }
  return { Directory };
}

/** Deleting a footnote: the same box as Orca's own ConfirmBox (icon, one
 * question, 取消 / 确定), opened next to where the delete was asked for. */
export function createDeleteConfirm(React: typeof import("react"), components: Components) {
  const { Button } = components;
  return function DeleteConfirm({ text, busy, onConfirm, onCancel }: { text: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
    return <div className="orca-menu orca-context-menu orca-confirm-box ofn-v3-confirm" role="alertdialog" aria-label={text} contentEditable={false}>
      <div className="orca-confirm-box-message"><i className="ti ti-alert-circle orca-confirm-box-icon" aria-hidden="true" /><p className="orca-confirm-box-text">{text}</p></div>
      <Button variant="outline" tabIndex={-1} onMouseDown={(event: import("react").MouseEvent) => event.preventDefault()} onClick={onCancel}>取消</Button>
      <Button variant="dangerous" tabIndex={-1} disabled={busy} onMouseDown={(event: import("react").MouseEvent) => event.preventDefault()} onClick={onConfirm}>确定</Button>
    </div>;
  };
}
