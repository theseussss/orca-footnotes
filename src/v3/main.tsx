import type { CursorData, EditorArg, Orca, PluginSettingsSchema } from "../../vendor/orca";
import { FootnoteController } from "./controller";
import { createSectionRenderer } from "./section";
import { SECTION_REPR, normalizeShortcut } from "./model";
import workspaceCss from "../vnext/workspace.css";
import referenceCss from "../vnext/native-reference.css";
import v3Css from "./v3.css";

export const version = "0.6.1";
const SETTINGS: PluginSettingsSchema = {
  tagName: { label: "尾注标签名", type: "string", defaultValue: "尾注" },
  footerTitle: { label: "尾注区标题", type: "string", defaultValue: "尾注" },
  footerStyle: { label: "尾注区样式", type: "singleChoice", defaultValue: "rule", choices: [{ label: "分隔线", value: "rule" }, { label: "标题", value: "heading" }] },
  navigatorVisible: { label: "默认显示尾注目录", type: "boolean", defaultValue: true },
  directoryClick: { label: "点击目录", type: "singleChoice", defaultValue: "body", choices: [{ label: "正文引用", value: "body" }, { label: "文末尾注", value: "footer" }] },
  referenceClick: { label: "点击上标", type: "singleChoice", defaultValue: "jump", choices: [{ label: "跳到文末尾注", value: "jump" }, { label: "编辑尾注内容", value: "edit" }] },
  insertShortcut: { label: "添加尾注的快捷键", description: "如 alt+ctrl+f、alt+shift+n；留空表示不用快捷键。和别的命令冲突时不改动。", type: "string", defaultValue: "alt+ctrl+f" },
  triggerSymbol: { label: "正文快速语法（可选，如 ^^；英文标点下输入）", type: "string", defaultValue: "" },
  directoryDefaultInset: { label: "目录默认右侧留距", type: "number", defaultValue: 60 },
  directoryDefaultLocked: { label: "目录默认锁定位置", type: "boolean", defaultValue: false },
  excerptLength: { label: "引用上下文长度", type: "number", defaultValue: 100 },
  archiveDays: { label: "归档保留天数（0 为不自动清理）", type: "number", defaultValue: 0 },
};
let runtime: FootnoteController | undefined;
let cleanup: Array<() => void> = [];

export async function load(name: string): Promise<void> {
  await unload();
  const api: Orca = orca;
  await api.plugins.setSettingsSchema(name, SETTINGS);
  const rt = new FootnoteController(api, name, window.Valtio.subscribe as any); runtime = rt;
  // Reachable from the real-Orca test scripts for diagnosis.
  (globalThis as any).__ofnV3 = rt; cleanup.push(() => { if ((globalThis as any).__ofnV3 === rt) delete (globalThis as any).__ofnV3; });
  try {
    const style = document.createElement("style"); style.dataset.ofnV3 = version;
    style.textContent = `${workspaceCss}\n${referenceCss}\n${v3Css}\n.ofn-next-entry{display:inline-flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;padding:4px;line-height:1;box-sizing:border-box}`;
    document.head.append(style); cleanup.push(() => style.remove());
    const React = window.React as unknown as typeof import("react"), { Button } = api.components;
    api.renderers.registerBlock(SECTION_REPR, false, createSectionRenderer(React, api, rt)); cleanup.push(() => api.renderers.unregisterBlock(SECTION_REPR));
    // Text forms of a section header: search text, Markdown/HTML export.
    const title = (content: any) => (Array.isArray(content?.content) ? content.content.map((f: any) => f?.t === "t" ? String(f.v ?? "") : "").join("") : String(content?.text ?? "")).trim() || "尾注";
    const converters: Record<string, (content: any) => string> = {
      plain: content => title(content),
      markdown: content => `---\n\n**${title(content)}**`,
      html: content => `<hr><p><strong>${title(content).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong></p>`,
    };
    for (const [format, convert] of Object.entries(converters)) {
      api.converters.registerBlock(format, SECTION_REPR, (content: any) => convert(content)); cleanup.push(() => api.converters.unregisterBlock(format, SECTION_REPR));
    }
    const report = (task: Promise<void>) => { void task.catch(error => rt.report(error)); };
    const command = (suffix: string, label: string, action: (editor: EditorArg) => Promise<void> | void) => {
      const id = `${name}.${suffix}`;
      api.commands.registerEditorCommand(id, editor => { report(Promise.resolve(action(editor))); return null; }, () => {}, { label, noFocusNeeded: true });
      cleanup.push(() => api.commands.unregisterEditorCommand(id)); return id;
    };
    const insert = command("insert", "添加尾注", editor => rt.beginInsert(editor[2] as CursorData | null));
    const directory = command("show-list", "尾注目录", () => rt.toggleNavigator());
    command("open-bin", "尾注回收站", () => rt.openBin());
    api.headbar.registerHeadbarButton(`${name}.entry`, () => <Button type="button" variant="plain" className="ofn-next-entry" title="尾注目录" aria-label="尾注目录"
      onMouseDown={(event: import("react").MouseEvent<HTMLButtonElement>) => event.preventDefault()} onClick={() => rt.toggleNavigator()}><i className="ti ti-superscript" aria-hidden="true" /></Button>);
    cleanup.push(() => api.headbar.unregisterHeadbarButton(`${name}.entry`));
    api.toolbar.registerToolbarButton(`${name}.tools`, [{ icon: "ti ti-superscript", tooltip: "添加尾注", command: insert }]); cleanup.push(() => api.toolbar.unregisterToolbarButton(`${name}.tools`));
    for (const [suffix, title, id] of [["insert", "尾注", insert], ["space", "尾注目录", directory]] as const) {
      api.slashCommands.registerSlashCommand(`${name}.slash-${suffix}`, { icon: "ti ti-superscript", group: "尾注", title, command: id });
      cleanup.push(() => api.slashCommands.unregisterSlashCommand(`${name}.slash-${suffix}`));
    }
    // Native block menu of a footnote (or its footer row): back to its citations,
    // delete; in the recycle bin or the archive: recover.
    const { MenuText } = api.components;
    api.blockMenuCommands.registerBlockMenuCommand(`${name}.entry-menu`, { worksOnMultipleBlocks: false,
      render: (blockId: number, _root: number, close: () => void) => {
        const state = rt.entryState(blockId);
        if (state === "recycled" || state === "archived") return <MenuText title="恢复尾注" preIcon="ti ti-restore" onClick={() => { close(); rt.recoverEntry(blockId); }} />;
        return state === "active" && rt.isEntry(blockId) ? <>
          <MenuText title="返回正文引用" preIcon="ti ti-arrow-back-up" onClick={(event: import("react").MouseEvent<Element>) => { const rect = event.currentTarget.getBoundingClientRect(); close(); rt.backToBody(blockId, rect); }} />
          <MenuText title="删除尾注" preIcon="ti ti-trash" dangerous onClick={(event: import("react").MouseEvent<Element>) => { const rect = event.currentTarget.getBoundingClientRect(); close(); rt.deleteEntry(blockId, rect); }} />
        </> : null;
      } });
    cleanup.push(() => api.blockMenuCommands.unregisterBlockMenuCommand(`${name}.entry-menu`));
    // The shortcut setting is applied to Orca's keymap only when it changes, so a
    // later change made in Orca's own shortcut settings is left alone.
    let seen: string | undefined;
    const syncShortcut = async () => {
      const raw = String(api.state.plugins[name]?.settings?.insertShortcut ?? "alt+ctrl+f").trim(), wanted = normalizeShortcut(raw);
      if (raw === seen) return; seen = raw;
      if (raw && !wanted) { api.notify("warn", `快捷键「${raw}」的写法认不出，没有改动。写法如 alt+ctrl+f。`); return; }
      if ((await api.plugins.getData(name, "v3:shortcut-applied")) === wanted) return;
      const taken = wanted && Object.entries(api.state.shortcuts ?? {}).find(([command, keys]) => command !== insert && keys === wanted)?.[0];
      if (taken) { api.notify("warn", `快捷键 ${wanted} 已被「${api.state.commands?.[taken]?.label ?? taken}」占用，添加尾注的快捷键没有改动。`); return; }
      await api.shortcuts.assign(wanted, insert); await api.plugins.setData(name, "v3:shortcut-applied", wanted);
    };
    const shortcutTask = () => { void syncShortcut().catch(error => console.warn("[footnotes] shortcut", error)); };
    cleanup.push(window.Valtio.subscribe(api.state.plugins, shortcutTask));
    shortcutTask();
    await rt.start();
  } catch (error) { await unload(); throw error; }
}
export async function unload(): Promise<void> {
  const rt = runtime; runtime = undefined; await rt?.stop();
  const pending = cleanup.reverse(); cleanup = [];
  for (const task of pending) try { task(); } catch (error) { console.warn("[footnotes] cleanup", error); }
}
