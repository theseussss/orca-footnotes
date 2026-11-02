# 尾注 · Orca Footnotes

虎鲸笔记（Orca Note）的原生尾注插件。[English](#english)

正文里是上标编号 `[1]`，页面末尾有尾注区，右侧有一个常驻的尾注目录。每条尾注都是一个普通的原生块，带 `#尾注` 标签：标签页能列出全库的尾注，能搜索、能查询，也能被 @ 引用。正文里的上标是指向尾注的原生引用，插件只负责把它显示成编号。

## 用法

- **添加尾注**：在正文里按 Ctrl+Alt+F（可在插件设置里改），或输入 `/尾注`，或点工具栏按钮，然后直接在原处打引文。候选框在光标下方：
  - 第一行是"新建尾注"；
  - 下面是本页（或绑定的上一层）已有的尾注，打的字和其中一条匹配时默认选中它，用来再次引用同一来源；
  - 分割线下面是别的页面的尾注和库里的资料（用 Orca 自己的搜索，拼音也能搜到），要用方向键选。选中一条资料，会新建一条尾注，内容是指向那条资料的引用，资料本身不变；
  - 什么都没打就按回车，等于普通换行；什么都没打时选"新建尾注"，上标先插好，光标到尾注区去写；
  - 打的网址和 DOI 会存成可点击的链接。
- **尾注区**：在页面（或放大进去的块）末尾，Orca 原生"引用"区之前。每一行就是那条尾注本身，直接改：
  - 在一条末尾回车另起一行：按 Tab 就成了这条的批注；不按 Tab 直接写，行前马上显示 `[·]`，光标离开这一行，它就成为一条新尾注；
  - 在一条中间回车，会拆成两条；
  - 行前的 `[n]` 点一下回到正文里的引用处；没被引用的尾注显示 `[·]`。
- **编号**：按第一次被引用的位置编号，同一条多处引用共用一个编号。默认按当前打开的页面编号（放大进某个块时，按那个块）。在尾注区标题行的"归集"里可以往上绑定到某一层，这一层下面的所有页面统一编号；绑定以后，点别的章节的尾注会跳到那一章里的引用处。
- **目录**：右侧常驻浮窗，一行一条。鼠标移上去，对应的上标会亮一下；点击跳到正文或文末（在设置里选）。可拖动、可锁定位置。
- **删除**：
  - 把一条尾注的文字删光，再按一次退格，它就删掉了；
  - 在尾注区一行上用 Orca 的"删除块"，也是删除这条尾注；
  - 目录里每行的"…"里也能删除；
  - 会连带删掉正文里的上标时，先弹出确认框；
  - 空的尾注直接删掉，有内容的进"尾注回收站"页。在回收站里用块菜单→"插件命令"→"恢复尾注"恢复；在回收站里再删一次，就进"尾注待清理归档"，到期按设置清理；
  - 撤销一次就能把一次操作撤回。
- **设置**：都在 Orca 的插件设置页里，包括标签名、尾注区样式、快捷键、目录行为、可选的正文快速语法（如 `^^`）、归档保留天数。

## 开发

```bash
npm ci
npm run types       # 下载 Orca 插件 API 的类型声明（只用于类型检查）
npm run typecheck
npm test
npm run package     # 生成 release/orca-footnotes-v<版本>.zip
```

把 `build/orca-footnotes` 复制到 Orca 的插件目录（`文档/orca/plugins/`），在 Orca 里启用即可。

`tests/real-orca/` 是在真实 Orca 里跑的测试：Orca 用 `--remote-debugging-port=9222` 启动，只打开一个专门的测试库，并设置 `OFN_TEST_REPO=<测试库 id>`。如果打开的不是这个库，脚本什么都不做。

代码结构：`src/v3/` 是插件本体，`src/vnext/` 和 `src/*.ts` 是沿用的公共部件与类型。

## 许可证

MIT

---

## English

Native footnotes for Orca Note. Citations in the text show as superscript numbers `[1]`; the end of the page has a footnote section; a floating directory sits on the right. Each footnote is an ordinary native block tagged `#尾注` (the tag name can be changed in settings), so it can be searched, queried and @-referenced. A citation is a native reference to the footnote; the plugin only displays it as a number.

- **Add**: Ctrl+Alt+F (configurable), `/尾注`, or the toolbar button, then type the citation in place. Matching footnotes of this page are preselected; footnotes of other pages and any material in the library (Orca's own search) are offered below a divider. Choosing material creates a footnote that references it. Typed URLs and DOIs become links.
- **Footer**: every row is the footnote itself, edited directly. Enter at the end of a row starts a new footnote (Tab makes it a comment instead). `[n]` jumps back to the citation; uncited footnotes show `[·]`.
- **Numbering**: by first citation, per page (or zoomed block) by default; can be bound to an upper level so its pages share one numbering.
- **Delete**: empty a footnote and press Backspace, or delete its footer row the Orca way. You are asked first when citations would be removed. Non-empty footnotes go to the recycle-bin page and can be restored from the block menu.

MIT License.
