import type { PluginSettingsSchema } from "../../vendor/orca";
import type { ScopePreferences } from "./types";
export function footnoteTrigger(value: unknown, fallback = ""): string {
  return typeof value === "string" && (value === "" || (Array.from(value).length === 1 && !/[\s@/#\\\p{C}]/u.test(value))) ? value : fallback;
}
export const NEXT_SETTINGS: PluginSettingsSchema = {
  navigatorVisible: { label: "默认显示尾注目录", type: "boolean", defaultValue: true },
  footerVisible: { label: "默认显示文末尾注", type: "boolean", defaultValue: true },
  directoryDefaultInset: { label: "目录默认右侧留距", type: "number", defaultValue: 60 },
  directoryDefaultLocked: { label: "目录默认锁定位置", type: "boolean", defaultValue: false },
  directoryClick: { label: "点击目录", type: "singleChoice", defaultValue: "body", choices: [{ label: "正文引用", value: "body" }, { label: "文末尾注", value: "footer" }] },
  triggerSymbol: { label: "尾注触发符号", type: "string", defaultValue: "" },
  referenceClick: { label: "点击上标", type: "singleChoice", defaultValue: "jump", choices: [{ label: "文末尾注", value: "jump" }, { label: "编辑引文", value: "edit" }] },
  footerStyle: { label: "尾注样式", type: "singleChoice", defaultValue: "rule", choices: [{ label: "分隔线", value: "rule" }, { label: "标题", value: "heading" }] },
  footerTitle: { label: "尾注标题", type: "string", defaultValue: "尾注" },
  excerptLength: { label: "引用上下文长度", type: "number", defaultValue: 100 },
  historyLimit: { label: "历史版本数", type: "number", defaultValue: 40 },
  archiveDays: { label: "归档保留天数", type: "number", defaultValue: 0 },
};
export function preferenceSettings(settings: Record<string, any>, base: ScopePreferences): ScopePreferences {
  return { ...base, placement: settings.placement === "right" ? "right" : settings.placement === "bottom" ? "bottom" : base.placement,
    navigatorVisible: typeof settings.navigatorVisible === "boolean" ? settings.navigatorVisible : base.navigatorVisible !== false,
    footerVisible: typeof settings.footerVisible === "boolean" ? settings.footerVisible : base.footerVisible !== false,
    directoryClick: settings.directoryClick === "footer" ? "footer" : settings.directoryClick === "body" ? "body" : base.directoryClick ?? "body",
    triggerSymbol: footnoteTrigger(settings.triggerSymbol, base.triggerSymbol ?? ""),
    footerStyle: settings.footerStyle === "heading" ? "heading" : settings.footerStyle === "rule" ? "rule" : base.footerStyle,
    title: typeof settings.footerTitle === "string" && settings.footerTitle.trim() ? settings.footerTitle.trim().slice(0, 80) : base.title,
    excerptLength: Number.isFinite(settings.excerptLength) ? Math.max(24, Math.min(500, Math.floor(settings.excerptLength))) : base.excerptLength,
    locationMode: settings.locationMode === "highlight" ? "highlight" : settings.locationMode === "choose" ? "choose" : base.locationMode,
    historyLimit: Number.isFinite(settings.historyLimit) ? Math.max(2, Math.min(200, Math.floor(settings.historyLimit))) : base.historyLimit,
    archiveDays: settings.archiveDays === 0 ? null : Number.isSafeInteger(settings.archiveDays) && settings.archiveDays > 0 ? Math.min(3650, settings.archiveDays) : base.archiveDays };
}
