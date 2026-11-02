import type * as ReactTypes from "react";
import type { DbId, Orca } from "../../vendor/orca";
import type { NativeTaskContext } from "./native-task-lease";
import { NATIVE_NOTE_FOREIGN_VIEW } from "./native-note-selection";

type ShellProps = Parameters<Orca["components"]["BlockShell"]>[0];
export type NativeNoteRendererProps = Pick<ShellProps,
  "panelId" | "blockId" | "mirrorId" | "rndId" | "blockLevel" | "indentLevel" | "renderingMode">;
/** This must be the value obtained from the ACTUAL native Provider. The runtime
 * queue capability is deliberately checked, not fabricated from public fields. */
export interface NativeNoteRenderContext extends NativeTaskContext {
  readonly editor: ReactTypes.RefObject<HTMLElement | null>;
}
/** A named, caller-authorized carrier, never an inferred DOM location. A
 * transient carrier is NOT a footer with a substituted ID. This label grants
 * no repository authority: resolve must validate its canonical representation,
 * ancestry and lease before it can be used here. */
export type NativeNoteRenderPresentation =
  | { readonly kind: "footer"; readonly blockId: DbId }
  | { readonly kind: "transient"; readonly blockId: DbId };
export interface NativeNoteRenderModel {
  /** Stable for this authorized source/catalog/presentation generation. */
  readonly lease: object;
  readonly noteId: DbId;
  readonly mirrorBlockId: DbId;
  readonly presentation: NativeNoteRenderPresentation;
  readonly panelId: string;
  readonly sourceRootId: DbId;
  readonly header: ReactTypes.ReactNode;
}
export interface NativeNoteRenderBinding {
  readonly model: NativeNoteRenderModel;
  readonly context: NativeNoteRenderContext;
  readonly editor: HTMLElement;
  /** Actual native M block obtained from this renderer's own header. */
  readonly element: HTMLElement;
  /** Physical/render-generation check only; NOT repository/command authority. */
  isCurrent(): boolean;
}
export interface NativeNoteRenderBridge {
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Pure, read-only lookup. Caller validates the complete canonical native-tree
   * record, catalog, normal body mode (not a query/backrefs presentation), source
   * and UNIQUE authorized mirror. No creation/upgrading
   * or data writes are permitted while React is rendering. */
  resolve(props: NativeNoteRendererProps, context: NativeNoteRenderContext): NativeNoteRenderModel | null;
  /** Register the source capture/surface lease BEFORE editable children mount.
   * Reject duplicate instances by returning null. Must not write canonical data.
   * Returning a cleanup means acceptance, not a database authorization. */
  attach(binding: NativeNoteRenderBinding): (() => void) | null;
  unavailable(props: NativeNoteRendererProps): ReactTypes.ReactNode;
  report(error: unknown): void;
}
const FOREIGN = NATIVE_NOTE_FOREIGN_VIEW;
const id = (value: unknown): value is DbId => Number.isSafeInteger(value);
function contextValue(value: unknown): NativeNoteRenderContext | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NativeNoteRenderContext>;
  return typeof candidate.panelId === "string" && id(candidate.rootBlockId)
    && typeof candidate.addTask === "function" && candidate.editor && typeof candidate.editor === "object"
    && "current" in candidate.editor ? candidate as NativeNoteRenderContext : null;
}
function matches(model: NativeNoteRenderModel, props: NativeNoteRendererProps, context: NativeNoteRenderContext): boolean {
  const presentation = model?.presentation;
  return !!model && !!model.lease && typeof model.lease === "object" && !("footerBlockId" in model)
    && !!presentation && typeof presentation === "object"
    && (presentation.kind === "footer" || presentation.kind === "transient")
    && Reflect.ownKeys(presentation).length === 2
    && Object.hasOwn(presentation, "kind") && Object.hasOwn(presentation, "blockId")
    && [model.noteId, model.mirrorBlockId, presentation.blockId, model.sourceRootId].every(id)
    && new Set([model.noteId, model.mirrorBlockId, presentation.blockId, model.sourceRootId]).size === 4
    && model.panelId === props.panelId && model.panelId === context.panelId
    && model.sourceRootId === context.rootBlockId && props.blockId === model.mirrorBlockId && props.mirrorId === model.noteId;
}
function sameAuthority(a: NativeNoteRenderModel, b: NativeNoteRenderModel): boolean {
  return a.lease === b.lease && a.noteId === b.noteId && a.mirrorBlockId === b.mirrorBlockId
    && a.panelId === b.panelId && a.sourceRootId === b.sourceRootId
    && a.presentation.kind === b.presentation.kind && a.presentation.blockId === b.presentation.blockId;
}
function physical(context: NativeNoteRenderContext, model: NativeNoteRenderModel, header: HTMLElement): { editor: HTMLElement; element: HTMLElement } | null {
  const editor = context.editor.current, element = header.closest<HTMLElement>(".orca-block");
  if (!editor?.isConnected || !header.isConnected || !element || header.closest(FOREIGN)
    || header.closest(".orca-block-editor") !== editor || element.dataset.id !== String(model.mirrorBlockId)
    || element.dataset.mirrorId !== String(model.noteId) || editor.dataset.blockId !== String(model.sourceRootId)) return null;
  const hideable = editor.parentElement, panel = hideable?.parentElement;
  if (!hideable?.matches(".orca-hideable:not(.orca-hideable-hidden)") || !panel?.matches(".orca-panel")
    || panel.dataset.panelId !== model.panelId || element.closest(".orca-panel") !== panel) return null;
  const main = [...editor.children].find(child => child.classList.contains("orca-block-editor-main"));
  const blocks = main && [...main.children].find(child => child.matches(".orca-block-editor-blocks[data-hl-container]"));
  if (!blocks?.contains(element) || element.closest(".orca-block-editor-blocks[data-hl-container]") !== blocks) return null;
  for (let parent = element.parentElement; parent && parent !== blocks; parent = parent.parentElement) {
    if (parent.matches(".orca-block") && parent.dataset.id === String(model.presentation.blockId)) return { editor, element };
  }
  return null;
}
/** Native-container factory, consumed by the plugin-owned native note entry.
 * Uses ONLY native BlockShell/BlockChildren
 * and the original Provider. No createRoot/portal/BlockPanel/second editor,
 * native function copy, editor pointer, data creation or direct DOM write.
 *
 * N's own content/header is non-editable; children are NOT wrapped in a false
 * editing host. The public child props establish N's logical paragraph indent
 * at 1, like Source's immediate paragraphs, without changing DOM ancestry,
 * canonical parents, Source root, queue or history. Empty Enter remains native.
 *
 * The production registry supplies authorization; the entry separately observes
 * its actual Provider in a commit effect. This factory does not create Source
 * authority, settle input, or grant repository/write permissions.
 */
export function createManagedNativeNoteRenderer(React: typeof ReactTypes,
  api: Pick<Orca, "components" | "contexts">, bridge: NativeNoteRenderBridge): (props: NativeNoteRendererProps) => ReactTypes.ReactElement {
  const { BlockShell, BlockChildren } = api.components;
  return function ManagedNativeNote(props: NativeNoteRendererProps): ReactTypes.ReactElement {
    React.useSyncExternalStore(bridge.subscribe, bridge.version, bridge.version);
    const context = contextValue(React.useContext(api.contexts.BlockEditorContext));
    const proposed = context && bridge.resolve(props, context);
    const model = proposed && context && matches(proposed, props, context) ? proposed : null;
    const current = React.useRef({ context, model, props }); current.current = { context, model, props };
    const header = React.useRef<HTMLDivElement>(null);
    const [accepted, setAccepted] = React.useState<NativeNoteRenderBinding | null>(null);
    const token = model?.lease, presentationKind = model?.presentation.kind, presentationBlockId = model?.presentation.blockId;
    // A child's layout effect may precede attachment of the Source editor's
    // ancestor host ref. Wait for the completed commit, with children still
    // gated off; never manufacture an editor ref or mount a second host.
    React.useEffect(() => {
      setAccepted(null);
      const state = current.current;
      if (!state.model || !state.context || !header.current || !matches(state.model, state.props, state.context)) return;
      // Explicit reads preserve valid inherited/non-enumerable scalar fields;
      // spreading the caller's model would silently drop those capabilities.
      const presentation = state.model.presentation;
      const captured: NativeNoteRenderModel = Object.freeze({ lease: state.model.lease, noteId: state.model.noteId,
        mirrorBlockId: state.model.mirrorBlockId, panelId: state.model.panelId, sourceRootId: state.model.sourceRootId,
        header: state.model.header, presentation: Object.freeze({ kind: presentation.kind, blockId: presentation.blockId }) });
      if (!matches(captured, state.props, state.context)) return;
      const bound = physical(state.context, captured, header.current);
      if (!bound) return;
      let open = true;
      const binding: NativeNoteRenderBinding = { ...bound, context: state.context, model: captured,
        isCurrent: () => {
          const latest = current.current;
          if (!open || latest.context !== binding.context || !latest.model
            || !matches(latest.model, latest.props, binding.context) || !sameAuthority(latest.model, binding.model) || !header.current) return false;
          const now = physical(binding.context, latest.model, header.current);
          return now?.element === binding.element && now.editor === binding.editor;
        } };
      let release: (() => void) | null;
      try { release = bridge.attach(binding); }
      catch (error) { open = false; bridge.report(error); return; }
      if (typeof release !== "function") { open = false; return; }
      setAccepted(binding);
      return () => { open = false; try { release(); } catch (error) { bridge.report(error); } };
    }, [context, token, presentationKind, presentationBlockId, props.panelId, props.blockId, props.mirrorId]);
    const active = !!model && !!context && accepted?.context === context && sameAuthority(accepted.model, model) && accepted.isCurrent();
    // BlockShell can independently render BackRefsChildren instead of its
    // supplied childrenJsx. Its simple mode suppresses BOTH child branches;
    // an unapproved/query instance must not mount a hidden native subtree.
    return <BlockShell {...props} renderingMode={active ? props.renderingMode : "simple"}
      contentAttrs={{ contentEditable: false }} reprClassName="ofn-native-note"
      contentJsx={<div ref={header} data-ofn-native-note-header="true">{model ? model.header : bridge.unavailable(props)}</div>}
      childrenJsx={active ? <BlockChildren blockId={model.noteId} panelId={props.panelId}
        blockLevel={0} indentLevel={0} renderingMode={props.renderingMode} /> : null} />;
  };
}
