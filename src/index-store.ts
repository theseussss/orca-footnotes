import type { Block, DbId, Orca } from "../vendor/orca";
import { clone, collectIndex, findRoot, type NoteIndex, type ReadBlock } from "./model";

export type IndexView = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; index: NoteIndex };
const LOADING: IndexView = Object.freeze({ status: "loading" });
export type SubscribeState = (state: object, callback: (ops?: unknown[][]) => void) => () => void;
export function repoKey(api: Orca): string {
  return JSON.stringify([api.state.dataDir, api.state.repoDir, api.state.repo]);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "脚注操作失败，请重试。";
}

/** A per-pass read snapshot; never writes fetched blocks into host state. */
export function createReader(api: Orca, expectedRepo = repoKey(api)): ReadBlock {
  const cache = new Map<DbId, Block | undefined>();
  function assertRepo() {
    if (repoKey(api) !== expectedRepo) throw new Error("笔记库已切换，请重新操作。");
  }
  const read: ReadBlock = async (id) => {
    assertRepo();
    if (cache.has(id)) return cache.get(id);
    const value = api.state.blocks[id] ?? await api.invokeBackend("get-block", id);
    assertRepo();
    const block = value ? clone(value as Block) : undefined;
    if (block && block.id !== id) throw new Error("读取到了不匹配的笔记块，操作已中止。");
    cache.set(id, block);
    return block;
  };
  read.prefetch = async (ids) => {
    assertRepo();
    const missing: DbId[] = [];
    for (const id of new Set(ids)) {
      if (cache.has(id)) continue;
      const live = api.state.blocks[id];
      if (live) cache.set(id, clone(live));
      else missing.push(id);
    }
    // Small batches avoid huge IPC messages on broad notes.
    for (let start = 0; start < missing.length; start += 200) {
      const batch = missing.slice(start, start + 200);
      const result = await api.invokeBackend("get-blocks", batch) as Block[];
      assertRepo();
      if (!Array.isArray(result)) throw new Error("当前 Orca 的批量读取接口返回了未知格式。");
      const wanted = new Set(batch);
      for (const block of result) if (block && wanted.has(block.id)) cache.set(block.id, clone(block));
      for (const id of batch) if (!cache.has(id)) cache.set(id, undefined);
    }
  };
  return read;
}

/** One shared reactive index per top-level note, including collapsed descendants. */
export class IndexStore {
  private listeners = new Map<DbId, Set<() => void>>();
  private views = new Map<DbId, IndexView>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private busy = false;
  private disposed = false;
  private stop: () => void;
  private repo: string;

  constructor(private api: Orca, subscribe: SubscribeState) {
    this.repo = repoKey(api);
    this.stop = subscribe(api.state, (ops) => {
      if (!ops || ops.some((op) => ["blocks", "repo", "repoDir", "dataDir"].includes(String((op[1] as unknown[])?.[0])))) {
        this.invalidate();
      }
    });
  }
  get = (id: DbId): IndexView => this.views.get(id) ?? LOADING;
  subscribe = (id: DbId, listener: () => void): (() => void) => {
    const group = this.listeners.get(id) ?? new Set();
    group.add(listener);
    this.listeners.set(id, group);
    this.invalidate();
    return () => {
      group.delete(listener);
      if (!group.size) { this.listeners.delete(id); this.views.delete(id); }
    };
  };
  invalidate = (): void => {
    if (this.disposed) return;
    this.revision++;
    const currentRepo = repoKey(this.api);
    if (this.repo !== currentRepo) {
      this.repo = currentRepo;
      this.views.clear();
      for (const group of this.listeners.values()) for (const fn of group) fn();
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.listeners.size) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 90);
  };
  async resolve(id: DbId): Promise<NoteIndex> {
    if (this.disposed) throw new Error("脚注插件已停用。");
    const read = createReader(this.api);
    const root = await findRoot(id, read);
    return collectIndex(root.id, read);
  }
  private async refresh(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    const version = this.revision;
    const read = createReader(this.api);
    const roots = new Map<DbId, Promise<NoteIndex>>();
    const next = new Map<DbId, IndexView>();
    try {
      for (const id of this.listeners.keys()) {
        try {
          const root = await findRoot(id, read);
          if (!roots.has(root.id)) roots.set(root.id, collectIndex(root.id, read));
          next.set(id, { status: "ready", index: await roots.get(root.id)! });
        } catch (error) {
          next.set(id, { status: "error", message: errorMessage(error) });
        }
      }
      if (!this.disposed && version === this.revision) {
        for (const [id, view] of next) {
          if (!this.listeners.has(id)) continue;
          this.views.set(id, view);
          for (const fn of this.listeners.get(id)!) fn();
        }
      }
    } finally {
      this.busy = false;
      if (!this.disposed && version !== this.revision) this.invalidate();
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.stop();
    this.listeners.clear();
    this.views.clear();
  }
}
