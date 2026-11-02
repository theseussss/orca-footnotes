import type { ReactNode } from "react";
import type { DbId, Orca } from "../../vendor/orca";
import type { WorkspaceActions, WorkspaceItem, WorkspaceView } from "./ui-contract";
import { nativeFieldDisplay, nativeFieldText } from "./input-text";
import { annotationViewSearchText, annotationViewText, isNativeAnnotationView } from "./content-view";

type Props = { view: WorkspaceView; actions: WorkspaceActions; close?: () => void };
type Components = Pick<Orca["components"], "Button" | "CompositionTextArea" | "MenuText" | "ContextMenu"> & Partial<Pick<Orca["components"], "MenuSeparator">>;
/** Actions of one exact body occurrence, opened from its superscript's context menu. */
export interface MarkerMenuActions { editContent(): void; showFooter(): void; removeHere(): void; close(): void }

/** Host components and host theme. Directory/composer are tools, not pages.
 * The persistent surface deliberately does NOT mount Menu's global keyboard
 * router: native Menu registers one even when keyboardNav=false. Local input
 * routing never mutates _orcaMenuId or catches keys in the body editor. */
export function createWorkspaceUI(React: typeof import("react"), components: Components) {
  const { Button, CompositionTextArea, MenuText, ContextMenu, MenuSeparator } = components;
  const menuContainer = { current: document.body };
  // These menus contain actions only, not editable native inputs. Preserve the
  // body's live selection on mouse activation rather than replaying an old
  // cursor after close. Native r menus (which contain an input) remain untouched.
  const actionMenuAttr = { onMouseDown: (event: import("react").MouseEvent<HTMLElement>) => event.preventDefault() };
  function Action({ children, onClick, disabled, danger, label, icon, className = "" }: {
    children?: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; label?: string; icon?: string; className?: string;
  }) {
    return <Button type="button" variant={danger ? "dangerous" : "plain"} className={`ofn-next-button ${className}`}
      aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon ? <i className={`ti ${icon}`} aria-hidden="true" /> : children}</Button>;
  }
  function linkedText(text: string): ReactNode[] {
    const nodes: ReactNode[] = [], pattern = /https?:\/\/[^\s<>"'`]+|\b(?:doi\s*:\s*)?10\.\d{4,9}\/[^\s<>"'`]+/giu;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index!; let value = match[0], previous: string;
      do {
        previous = value; value = value.replace(/[.,;:!?，。；：！？、…“”‘’»]+$/u, "");
        for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["【", "】"]]) {
          if (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -close.length);
        }
      } while (value !== previous);
      let url: URL;
      try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://doi.org/${value.replace(/^doi\s*:\s*/i, "")}`); } catch { continue; }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      nodes.push(text.slice(cursor, start));
      nodes.push(<a key={start} className="ofn-next-link" href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={event => event.stopPropagation()}>{value}</a>);
      cursor = start + value.length;
    }
    nodes.push(text.slice(cursor)); return nodes;
  }
  function Text({ text }: { text: string }) { return <div className="ofn-next-text">{text ? linkedText(text) : <span className="ofn-next-muted">（空）</span>}</div>; }
  function Status({ view }: { view: WorkspaceView }) { return <>{view.error && <p className="ofn-next-error" role="alert">{view.error}</p>}</>; }
  function hoverProps(id: DbId | null, actions: WorkspaceActions) {
    return { onMouseEnter: () => actions.hover(id), onMouseLeave: () => actions.hover(null), onFocus: () => actions.hover(id),
      onBlur: (event: import("react").FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) actions.hover(null); } };
  }
  function useHoverCleanup(actions: WorkspaceActions) {
    const current = React.useRef(actions); current.current = actions;
    React.useEffect(() => () => current.current.hover(null), []);
  }
  const allActive = (view: WorkspaceView) => [...view.entries, ...view.candidates, ...(view.usedElsewhere ?? [])];
  function ItemMenu({ row, actions, close, state = "active" }: { row: WorkspaceItem; actions: WorkspaceActions; close: () => void; state?: "active" | "recycled" | "archived" }) {
    const call = (fn: () => void) => () => { close(); fn(); };
    return <>
      {state === "active" ? <>
        <MenuText title="编辑引文" preIcon="ti ti-pencil" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); close(); actions.edit(row.item.id, rect); }} />
        <MenuText title="引用此条" preIcon="ti ti-link" onClick={call(() => actions.use(row.item.id))} />
        {row.number != null && <MenuText title="正文引用" preIcon="ti ti-arrow-back-up" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); close(); actions.locate(row.item.id, rect); }} />}
        <MenuText title="删除尾注" preIcon="ti ti-trash" dangerous onClick={call(() => actions.recycle(row.item.id))} />
      </> : <>
        <MenuText title="恢复尾注" preIcon="ti ti-restore" onClick={call(() => actions.recover(row.item.id))} />
        {state === "recycled" && <MenuText title="再次删除" preIcon="ti ti-trash" dangerous onClick={call(() => actions.archive(row.item.id))} />}
      </>}
      <MenuText title="复制 Markdown" preIcon="ti ti-copy" onClick={call(() => actions.copyItem(row.item.id))} />
    </>;
  }
  /** The visible entry to an entry's own menu, at the right of its row. */
  function RowMore({ number, open }: { number?: number; open: (event: import("react").UIEvent) => void }) {
    return <Button type="button" variant="plain" className="ofn-next-button ofn-next-row-more" aria-label={number == null ? "尾注操作" : `尾注 ${number} 操作`} title="尾注操作"
      onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>;
  }
  /** Collection level of the current footer. Options are the current page and
   * its ancestors only: choosing one extends the shared pool/list/numbering up
   * to that level. Browsing or filtering changes nothing; a click is the choice. */
  function ScopePicker({ view, actions }: Props) {
    const [query, setQuery] = React.useState("");
    const options = view.scopeOptions, current = view.scopeRootId;
    const own = current != null && current === view.sourceRootId;
    // Only this page's own explicit choice can be undone here; an inherited
    // upper root also governs its other pages and is changed from there.
    const explicit = own && view.preferences.roots.includes(current!);
    const label = own ? "本页" : view.scopeLabel || "本页";
    // scopeOptions run from the current page upward; a path reads top-down.
    const path = (index: number) => options.slice(index + 1).map(option => option.label).reverse().join(" / ");
    const needle = query.trim().toLocaleLowerCase();
    const rows = options.map((option, index) => ({ option, index })).filter(({ option }) => !needle || option.label.toLocaleLowerCase().includes(needle));
    return <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} onClosed={() => setQuery("")} menu={close => <div className="ofn-next-scope-menu" aria-label="选择归集层级">
      {options.length > 8 && <input className="ofn-next-input ofn-next-scope-filter" aria-label="查找归集层级" placeholder="查找上层页面" value={query}
        onKeyDown={event => event.stopPropagation()} onChange={event => setQuery(event.currentTarget.value)} />}
      {rows.map(({ option, index }) => <MenuText key={option.id} title={index === 0 ? "仅本页" : option.label} subtitle={path(index) || undefined}
        preIcon={option.id === current ? "ti ti-check" : "ti ti-point"} onClick={() => { close(); if (option.id !== current) actions.scope(option.id); }} />)}
      {explicit && <MenuText title="恢复自动" preIcon="ti ti-arrow-back-up" onClick={() => { close(); actions.scope(null); }} />}
    </div>}>
      {open => <Button type="button" variant="plain" className="ofn-next-button ofn-next-scope-button" aria-label={`归集：${label}`} title="选择归集层级" disabled={view.loading || !options.length}
        onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={open}>
        <span className="ofn-next-scope-label">归集：{label}</span><i className="ti ti-chevron-down" aria-hidden="true" /></Button>}
    </ContextMenu>;
  }
  /** Range-level actions belong to the footer of that range. */
  function FooterHeader({ view, actions }: Props) {
    return <div className="ofn-next-footer-header">
      {view.preferences.footerStyle === "heading" ? <h2 className="ofn-next-footer-heading">{view.preferences.title}</h2> : <div className="ofn-next-rule" role="separator" />}
      <div className="ofn-next-footer-tools">
        <ScopePicker view={view} actions={actions} />
        <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={close => <>
          <MenuText title="复制归集全文 Markdown" preIcon="ti ti-copy" disabled={view.loading} onClick={() => { close(); actions.copyDocument(); }} />
          <MenuText title="收集引文" preIcon="ti ti-plus" disabled={view.loading} onClick={() => { close(); actions.create(); }} />
          <MenuText title="隐藏文末尾注" preIcon="ti ti-eye-off" onClick={() => { close(); actions.toggleFooter(); }} />
          {MenuSeparator && <MenuSeparator />}
          <MenuText title="管理尾注…" preIcon="ti ti-notes" onClick={() => { close(); actions.manage(); }} />
        </>}>
          {open => <Button type="button" variant="plain" className="ofn-next-button" aria-label="文末尾注操作" title="文末尾注操作"
            onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>}
        </ContextMenu>
      </div>
    </div>;
  }
  /** Menu of the exact superscript that was right-clicked. Opened by the
   * controller with that marker as anchor; ordinary @ references are untouched. */
  function MarkerMenu({ target, number, actions }: { target: HTMLElement; number?: number; actions: MarkerMenuActions }) {
    return <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} onClosed={() => actions.close()} menu={close => <>
      <MenuText title="编辑注释内容" preIcon="ti ti-pencil" onClick={() => { close(); actions.editContent(); }} />
      <MenuText title={number == null ? "跳到文末尾注" : `跳到文末尾注 ${number}`} preIcon="ti ti-list-numbers" onClick={() => { close(); actions.showFooter(); }} />
      {MenuSeparator && <MenuSeparator />}
      <MenuText title="只移除此处引用" preIcon="ti ti-unlink" dangerous onClick={() => { close(); actions.removeHere(); }} />
    </>}>
      {(open, _close, shown) => <MarkerMenuOpener target={target} open={open} shown={shown} />}
    </ContextMenu>;
  }
  function MarkerMenuOpener({ target, open, shown }: { target: HTMLElement; open: (event: import("react").UIEvent) => void; shown: boolean }) {
    const opened = React.useRef<HTMLElement | null>(null);
    React.useLayoutEffect(() => {
      if (opened.current === target || shown) return; opened.current = target;
      // Native ContextMenu only reads target/preventDefault/stopPropagation.
      open({ target, currentTarget: target, preventDefault() {}, stopPropagation() {} } as unknown as import("react").UIEvent);
    }, [target, shown]);
    return null;
  }
  function Navigator({ view, actions }: Props) {
    useHoverCleanup(actions);
    const locked = view.directoryLayout?.locked === true;
    return <section className="orca-menu ofn-next-surface ofn-next-navigator" aria-label="尾注目录" aria-busy={view.loading}>
      {/* The directory manages only itself. Range actions live in the footer
          header, library maintenance in 管理尾注. A hidden footer has no header,
          so its way back stays here until the footer is shown again. */}
      <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={close => <>
        <MenuText title={locked ? "解除锁定" : "锁定位置"} preIcon={locked ? "ti ti-lock-open" : "ti ti-lock"} onClick={() => { close(); actions.toggleDirectoryLock(); }} />
        <MenuText title="恢复默认位置" preIcon="ti ti-focus-centered" onClick={() => { close(); actions.resetDirectoryPosition(); }} />
        {view.footerDisplayed === false && <MenuText title="显示文末尾注" preIcon="ti ti-list-numbers" onClick={() => { close(); actions.toggleFooter(); }} />}
      </>}>
        {open => <header className="ofn-next-header ofn-next-directory-header" data-ofn-drag-handle="true" data-locked={String(locked)} onContextMenu={open}>
          <span className="ofn-next-title" title={view.scopeLabel ? `归集：${view.scopeLabel}` : undefined}>尾注</span>
          <Button type="button" variant="plain" className="ofn-next-button" aria-label={locked ? "解锁目录位置" : "锁定目录位置"} title={locked ? "解锁目录位置" : "锁定目录位置"}
            aria-pressed={locked} onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={() => actions.toggleDirectoryLock()}><i className={`ti ${locked ? "ti-lock" : "ti-lock-open"}`} aria-hidden="true" /></Button>
          <Button type="button" variant="plain" className="ofn-next-button" aria-label="尾注目录操作" title="尾注目录操作" onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>
          <Button type="button" variant="plain" className="ofn-next-button" aria-label="关闭尾注目录" title="关闭尾注目录" onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={() => actions.closeNavigator()}><i className="ti ti-x" aria-hidden="true" /></Button>
        </header>}
      </ContextMenu>
      <Status view={view} />
      <ol className="ofn-next-nav-list" aria-label="已引用尾注">
        {view.entries.map(row => <li key={row.item.id} data-item-id={row.item.id} className="ofn-next-nav-row" {...hoverProps(row.item.id, actions)}>
          <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={close => <ItemMenu row={row} actions={actions} close={close} />}>
            {open => <>
              <Button type="button" variant="plain" className={`ofn-next-nav-item${view.selectedItemId === row.item.id ? " orca-key-selected" : ""}`} aria-current={view.selectedItemId === row.item.id ? "true" : undefined} aria-label={`尾注 ${row.number}：${annotationViewText(row.item)}`} disabled={view.loading}
                onContextMenu={open} onClick={(event: import("react").MouseEvent<HTMLButtonElement>) => actions.select(row.item.id, event.currentTarget.getBoundingClientRect())}>
                <span className="ofn-next-number">[{row.number}]</span><span className="ofn-next-nav-quotation">{annotationViewText(row.item)}</span>
              </Button>
              <RowMore number={row.number} open={open} />
            </>}
          </ContextMenu>
        </li>)}
        {!view.entries.length && <li><MenuText title="暂无尾注" disabled /></li>}
      </ol>
    </section>;
  }
  function ScopeChoice({ view, actions }: Props) {
    const explicit = view.scopeRootId != null && view.preferences.roots.includes(view.scopeRootId);
    return <label className="ofn-next-control ofn-next-control-wide"><span>归集到</span><select className="ofn-next-select" aria-label="归集到" disabled={view.loading} value={explicit ? String(view.scopeRootId) : ""} onChange={event => actions.scope(event.currentTarget.value ? Number(event.currentTarget.value) : null)}>
      <option value="">自动</option>{view.scopeOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      {explicit && !view.scopeOptions.some(option => option.id === view.scopeRootId) && <option value={view.scopeRootId}>{view.scopeLabel}</option>}
    </select></label>;
  }
  function ScopeControls({ view, actions }: Props) {
    const prefs = view.preferences;
    const retention = [...new Set([...(prefs.archiveDays == null ? [] : [prefs.archiveDays]), 7, 30, 90, 365])];
    return <section className="ofn-next-settings" aria-label="尾注设置"><div className="ofn-next-controls">
      <label className="ofn-next-control"><span><input type="checkbox" aria-label="显示尾注目录" checked={prefs.navigatorVisible !== false} disabled={view.loading} onChange={event => actions.navigatorVisible(event.currentTarget.checked)} /> 默认显示目录</span></label>
      <label className="ofn-next-control"><span><input type="checkbox" aria-label="显示文末尾注" checked={prefs.footerVisible !== false} disabled={view.loading} onChange={event => actions.footerVisible(event.currentTarget.checked)} /> 默认显示文末</span></label>
      <label className="ofn-next-control"><span>点击目录</span><select className="ofn-next-select" aria-label="点击目录" value={prefs.directoryClick ?? "body"} disabled={view.loading} onChange={event => actions.directoryClick(event.currentTarget.value as "body" | "footer")}><option value="body">正文引用</option><option value="footer">文末尾注</option></select></label>
      <label className="ofn-next-control"><span>尾注样式</span><select className="ofn-next-select" aria-label="尾注样式" value={prefs.footerStyle} disabled={view.loading} onChange={event => actions.footerStyle(event.currentTarget.value as typeof prefs.footerStyle)}><option value="rule">分隔线</option><option value="heading">标题</option></select></label>
      <label className="ofn-next-control"><span>上下文长度</span><input className="ofn-next-input" aria-label="定位上下文长度" type="number" min={24} max={500} value={prefs.excerptLength} disabled={view.loading} onChange={event => { const number = Number(event.currentTarget.value); if (Number.isSafeInteger(number) && number >= 24) actions.excerptLength(number); }} /></label>
      <label className="ofn-next-control"><span>归档保留天数</span><select className="ofn-next-select" aria-label="归档保留期限" value={prefs.archiveDays ?? "none"} disabled={view.loading} onChange={event => actions.archiveDays(event.currentTarget.value === "none" ? null : Number(event.currentTarget.value))}><option value="none">不自动清理</option>{retention.map(days => <option key={days} value={days}>{days} 天</option>)}</select></label>
    </div></section>;
  }
  function LibraryItem({ row, state, view, actions }: Props & { row: WorkspaceItem; state: "active" | "recycled" | "archived" }) {
    return <li className="ofn-next-row" data-item-id={row.item.id}><Text text={annotationViewText(row.item)} />
      <div className="ofn-next-row-meta">{row.number != null && <span>[{row.number}]</span>}<span>{row.referenceCount} 处引用</span>
        <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={close => <ItemMenu row={row} actions={actions} close={close} state={state} />}> 
          {open => <Button type="button" variant="plain" aria-label="尾注操作" title="尾注操作" onClick={open}><i className="ti ti-dots" /></Button>}
        </ContextMenu>
      </div></li>;
  }
  function Workspace({ view, actions, close }: Props) {
    const root = React.useRef<HTMLElement>(null);
    React.useLayoutEffect(() => { root.current?.querySelector<HTMLInputElement>('input[aria-label="查找引文"]')?.focus({ preventScroll: true }); }, []);
    const [tab, setTab] = React.useState<"notes" | "recycled" | "settings">("notes"), [collection, setCollection] = React.useState<"all" | "referenced" | "candidates">("all"), [query, setQuery] = React.useState("");
    const rows = (collection === "referenced" ? view.entries : collection === "candidates" ? view.candidates : allActive(view)).filter(row => annotationViewSearchText(row.item).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return <section ref={root} className="orca-menu ofn-next-surface ofn-next-workspace" aria-label="管理尾注" aria-busy={view.loading}>
      <header className="ofn-next-header"><span className="ofn-next-title">尾注</span>
        <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={done => <>
          <MenuText title="复制归集全文 Markdown" preIcon="ti ti-copy" disabled={view.loading} onClick={() => { done(); actions.copyDocument(); }} />
          <MenuText title="旧格式迁移" preIcon="ti ti-file-import" disabled={view.loading} onClick={() => { done(); actions.importLegacy(); }} />
        </>}>{open => <Button type="button" variant="plain" className="ofn-next-button" aria-label="尾注管理操作" title="尾注管理操作" onClick={open}><i className="ti ti-dots" aria-hidden="true" /></Button>}</ContextMenu>
        {close && <Action label="关闭尾注管理" icon="ti-x" onClick={close} />}</header>
      <div className="ofn-next-controls"><ScopeChoice view={view} actions={actions} /></div>
      <nav className="ofn-next-library-tabs" aria-label="尾注管理分区">{([["notes", "资料"], ["recycled", "回收"], ["settings", "设置"]] as const).map(([key, text]) => <Action key={key} className={tab === key ? "orca-key-selected" : ""} onClick={() => setTab(key)} label={text}>{text}</Action>)}</nav>
      <Status view={view} />
      {tab === "notes" ? <><div className="ofn-next-toolbar"><Action label="收集引文" icon="ti-plus" disabled={view.loading} onClick={() => actions.create()} /><Action label="复制整篇 Markdown" icon="ti-copy" disabled={view.loading} onClick={() => actions.copyDocument()} /></div>
        <div className="ofn-next-controls"><input className="ofn-next-input" aria-label="查找引文" value={query} onChange={event => setQuery(event.currentTarget.value)} /><select className="ofn-next-select" aria-label="引文集合" value={collection} onChange={event => setCollection(event.currentTarget.value as typeof collection)}><option value="all">全部</option><option value="referenced">已引用</option><option value="candidates">未引用</option></select></div>
        <ul className="ofn-next-list">{rows.map(row => <LibraryItem key={row.item.id} row={row} state="active" view={view} actions={actions} />)}</ul>
      </> : tab === "settings" ? <ScopeControls view={view} actions={actions} /> : <>
        <ul className="ofn-next-list">{view.recycled.map(row => <LibraryItem key={row.item.id} row={row} state="recycled" view={view} actions={actions} />)}</ul>
        <details className="ofn-next-archive"><summary>归档 {view.archived.length}</summary><ul className="ofn-next-list">{view.archived.map(row => <LibraryItem key={row.item.id} row={row} state="archived" view={view} actions={actions} />)}</ul>
          <Action label="清理到期归档" disabled={view.loading || view.preferences.archiveDays == null || !view.archived.length} onClick={() => actions.purgeExpired()}>清理到期归档</Action></details>
      </>}
    </section>;
  }
  function Footer({ view, actions }: Props) {
    useHoverCleanup(actions);
    return <section className="ofn-next-surface ofn-next-footer" aria-label="文末尾注">
      <FooterHeader view={view} actions={actions} />
      {view.error && <p role="alert" className="ofn-next-error">{view.error}</p>}
      <ol className="ofn-next-footer-list">{view.entries.map(row => <li className="ofn-next-footer-row" key={row.item.id} data-item-id={row.item.id} {...hoverProps(row.item.id, actions)}>
        <span className="ofn-next-number"><button type="button" className="ofn-next-note-link" aria-label={`正文引用 ${row.number}`} onClick={event => actions.locate(row.item.id, event.currentTarget.getBoundingClientRect())}>[{row.number}]</button></span><Text text={annotationViewText(row.item)} />
        <ContextMenu container={menuContainer} noPointerLogic menuAttr={actionMenuAttr} menu={close => <ItemMenu row={row} actions={actions} close={close} />}>
          {open => <RowMore number={row.number} open={open} />}
        </ContextMenu>
      </li>)}</ol>
    </section>;
  }
  function SaveStatus({ state, error, privateDraft = false }: { state: string; error?: string; privateDraft?: boolean }) {
    const label = privateDraft ? state === "saved" ? "草稿已保留" : "草稿保留中" : state === "saved" ? "已保存" : "保存中";
    return error ? <p className="ofn-next-error" role="alert">{error}</p> : <span className="ofn-next-save-state" role="status" aria-label={label} title={label}><i aria-hidden="true" className={`ti ${state === "saved" ? privateDraft ? "ti-notes" : "ti-check" : "ti-loader"}`} /></span>;
  }
  function Input({ view, actions }: Props) {
    const frame = view.composer!, input = React.useRef<HTMLTextAreaElement>(null), composing = React.useRef(false);
    const [selected, setSelected] = React.useState(0);
    const query = frame.draft.text.trim().toLocaleLowerCase(), matches = query ? frame.items.filter(row => annotationViewSearchText(row.item).toLocaleLowerCase().includes(query)) : [];
    React.useLayoutEffect(() => { if (input.current && input.current.value !== nativeFieldDisplay(frame.draft.text) && !composing.current) input.current.value = frame.draft.text; }, [frame.draft.text, frame.sessionId]);
    React.useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, [frame.sessionId]);
    React.useEffect(() => { setSelected(0); }, [frame.draft.text, matches.map(row => row.item.id).join(",")]);
    const publish = () => { if (!composing.current && !frame.closing && input.current) actions.changeInput(nativeFieldText(frame.draft.text, input.current.value), frame.draft.comment); };
    const confirm = (index = selected) => { if (composing.current || frame.closing) return; publish(); if (input.current?.value.trim()) actions.confirmInput(matches[index]?.item.id); };
    function key(event: import("react").KeyboardEvent<HTMLTextAreaElement>) {
      event.stopPropagation(); if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || frame.closing) return;
      if (event.key === "Escape") { event.preventDefault(); actions.cancelInput(); }
      else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !input.current?.value.includes("\n")) { event.preventDefault(); setSelected(value => (value + (event.key === "ArrowDown" ? 1 : -1) + matches.length + 1) % (matches.length + 1)); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); confirm(); }
    }
    return <section className="orca-menu ofn-next-surface ofn-next-composer" aria-label="添加尾注" data-input-session={frame.sessionId} aria-busy={frame.closing}>
      <Status view={view} />
      <CompositionTextArea ref={input} className="ofn-next-native-input" aria-label="引文" rows={Math.min(6, Math.max(1, nativeFieldDisplay(frame.draft.text).split("\n").length))} maxLength={50000} disabled={frame.closing} value={nativeFieldDisplay(frame.draft.text)}
        onInput={(event: import("react").FormEvent<HTMLTextAreaElement>) => { if (!(event.nativeEvent as InputEvent).isComposing) publish(); }} onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; publish(); }} onKeyDown={key} />
      {query && <div className="ofn-next-input-options" role="listbox" aria-label="引文候选">{matches.map((row, index) => <MenuText key={row.item.id} title={annotationViewText(row.item)} className={`ofn-next-input-candidate${selected === index ? " orca-key-selected" : ""}`} role="option" aria-selected={selected === index}
        onMouseEnter={() => setSelected(index)} onClick={() => actions.confirmInput(row.item.id)} />)}
        <MenuText title="新建尾注" preIcon="ti ti-plus" className={selected === matches.length ? "orca-key-selected" : ""} role="option" aria-selected={selected === matches.length} onMouseEnter={() => setSelected(matches.length)} onClick={() => actions.confirmInput()} />
      </div>}
      <div className="ofn-next-input-controls"><SaveStatus state={frame.draft.state} error={frame.draft.error} privateDraft />
        {(frame.draft.state === "error" || view.error) && <Action label="重试保存" icon="ti-refresh" onClick={() => actions.retryInput()} />}
        <Action label="取消添加" icon="ti-x" disabled={frame.closing && !frame.draft.error && !view.error} onClick={() => { if (!composing.current) actions.cancelInput(); }} />
        <Action label="确认尾注" icon="ti-check" disabled={frame.closing || !frame.draft.text.trim()} onClick={() => confirm()} />
      </div>
    </section>;
  }
  function Editor(props: Props) {
    const item = props.view.editor?.item;
    // Defensive UI boundary: even a misrouted native view cannot mount the V1
    // textarea/effects or publish its display projection through changeDraft.
    if (item && isNativeAnnotationView(item)) return <section className="orca-menu ofn-next-surface ofn-next-editor" aria-label="尾注只读预览"><Text text={annotationViewText(item)} /></section>;
    return <PlainEditor {...props} />;
  }
  function PlainEditor({ view, actions }: Props) {
    const text = React.useRef<HTMLTextAreaElement>(null), comment = React.useRef<HTMLTextAreaElement>(null), composing = React.useRef(false), [commentOpen, setCommentOpen] = React.useState(false), [historyOpen, setHistoryOpen] = React.useState(false);
    const frame = view.editor!;
    React.useLayoutEffect(() => { if (!composing.current && text.current && text.current.value !== nativeFieldDisplay(frame.draft.text)) text.current.value = frame.draft.text; if (!composing.current && comment.current && comment.current.value !== nativeFieldDisplay(frame.draft.comment)) comment.current.value = frame.draft.comment; }, [frame.draft.text, frame.draft.comment, frame.sessionId]);
    React.useLayoutEffect(() => { text.current?.focus({ preventScroll: true }); }, [frame.sessionId]);
    const publish = () => { if (!composing.current && !frame.closing && text.current) actions.changeDraft(nativeFieldText(frame.draft.text, text.current.value), comment.current ? nativeFieldText(frame.draft.comment, comment.current.value) : frame.draft.comment); };
    const inputProps = { onInput: (event: import("react").FormEvent<HTMLTextAreaElement>) => { if (!(event.nativeEvent as InputEvent).isComposing) publish(); }, onCompositionStartCapture: () => { composing.current = true; }, onCompositionEndCapture: () => { composing.current = false; publish(); },
      onKeyDown: (event: import("react").KeyboardEvent<HTMLTextAreaElement>) => { event.stopPropagation(); if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); publish(); actions.closeEditor(); } } };
    return <section className="orca-menu ofn-next-surface ofn-next-editor" data-editor-session={frame.sessionId} aria-label="编辑尾注">
      <CompositionTextArea ref={text} {...inputProps} className="ofn-next-native-input" aria-label="注释正文" rows={Math.min(8, Math.max(1, nativeFieldDisplay(frame.draft.text).split("\n").length))} maxLength={50000} disabled={frame.closing} value={nativeFieldDisplay(frame.draft.text)} />
      <div className="ofn-next-input-controls">{frame.canRemoveOccurrence && <Action label="只移除此处引用" icon="ti-unlink" disabled={frame.closing} onClick={() => { if (!composing.current) actions.removeSelectedOccurrence(); }} />}<Action label="批注" icon="ti-message-circle" onClick={() => { if (!composing.current) setCommentOpen(value => !value); }} /><Action label="历史版本" icon="ti-history" onClick={() => setHistoryOpen(value => !value)} /><SaveStatus state={frame.draft.state} error={frame.draft.error} /><Action label="完成编辑" icon="ti-check" disabled={frame.closing} onClick={() => { if (!composing.current) { publish(); actions.closeEditor(); } }} /></div>
      {commentOpen && <CompositionTextArea ref={comment} {...inputProps} className="ofn-next-native-input" aria-label="整条批注" rows={3} maxLength={50000} disabled={frame.closing} value={nativeFieldDisplay(frame.draft.comment)} />}
      {historyOpen && <ol className="ofn-next-list ofn-next-history">{frame.history.map(version => <li key={version.revision}><details><summary>{new Date(version.at).toLocaleString()}</summary><Text text={version.text} />{version.comment && <Text text={version.comment} />}<Action disabled={view.loading} onClick={() => actions.restoreHistory(version.revision)}>恢复</Action></details></li>)}</ol>}
    </section>;
  }
  function Locations({ view, actions }: Props) {
    const current = React.useRef(actions), root = React.useRef<HTMLElement>(null); current.current = actions;
    React.useEffect(() => () => current.current.hoverOccurrence(null), []);
    React.useLayoutEffect(() => { root.current?.querySelector<HTMLElement>(".ofn-next-location")?.focus({ preventScroll: true }); }, []);
    const move = (event: import("react").KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      const rows = [...root.current?.querySelectorAll<HTMLElement>(".ofn-next-location") ?? []], index = rows.indexOf(document.activeElement as HTMLElement);
      if (!rows.length || index < 0) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation();
        const key = rows[index].dataset.ofnLocationKey; if (key) current.current.chooseLocation(key);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus({ preventScroll: true });
    };
    return <section ref={root} className="orca-menu ofn-next-surface ofn-next-locations" aria-label="正文引用位置" onKeyDown={move}><div className="ofn-next-header" data-ofn-drag-handle="true"><span>正文引用</span><Action label="关闭位置选择" icon="ti-x" onClick={() => actions.closeLocations()} /></div>
      <div role="listbox" aria-label="正文引用位置候选">{(view.locations ?? []).map(location => <MenuText key={location.key} title={location.excerpt} subtitle={location.pageLabel} className="ofn-next-location" data-ofn-location-key={location.key} role="option" tabIndex={0} onClick={() => actions.chooseLocation(location.key)} onMouseEnter={() => actions.hoverOccurrence(location.key)} onMouseLeave={() => actions.hoverOccurrence(null)} onFocus={() => actions.hoverOccurrence(location.key)} onBlur={() => actions.hoverOccurrence(null)} />)}</div>
    </section>;
  }
  function Deletion({ view, actions }: Props) {
    const value = view.deletion; if (!value) return null;
    return <section className="orca-menu ofn-next-surface ofn-next-deletion" role="alertdialog" aria-label="删除尾注"><h2 className="ofn-next-title">{value.references ? `删除尾注及全部 ${value.references} 处引用？` : "删除尾注？"}</h2><Text text={value.text} />
      <div className="ofn-next-toolbar"><Action onClick={() => actions.cancelRecycle()}>取消</Action><Action danger disabled={view.loading} onClick={() => actions.confirmRecycle()}>删除</Action></div></section>;
  }
  return { Navigator, Workspace, Footer, FooterHeader, ScopePicker, Editor, Input, Locations, Deletion, Text, MarkerMenu };
}
