# 尾注 · Orca Footnotes

虎鲸笔记（Orca Note）的原生尾注插件。[English](#english)

正文里是上标编号 `[1]`；页面底部的标签栏里有一个“尾注”标签，和 Orca 的“引用”“同标签”排在一起（也可以放回页面末尾）；右上方贴着一个抽屉式的尾注目录。每条尾注都是一个普通的原生块，带 `#尾注` 标签：标签页能列出全库的尾注，能搜索、能查询，也能被 @ 引用。正文里的上标是指向尾注的原生引用，插件只负责把它显示成编号。

## 用法

- **添加尾注**：在正文里按 Ctrl+Alt+F（可在插件设置里改），或输入 `/尾注`，或点工具栏按钮，然后直接在原处打引文。候选框在光标下方：
  - 第一行是"新建尾注"；
  - 下面是本页（或绑定的上一层）已有的尾注，打的字和其中一条匹配时默认选中它，用来再次引用同一来源；
  - 分割线下面是别的页面的尾注和库里的资料（用 Orca 自己的搜索，拼音也能搜到），要用方向键选。选中一条资料，会新建一条尾注，内容是指向那条资料的引用，资料本身不变；
  - 什么都没打就按回车，等于普通换行；什么都没打时选"新建尾注"，上标先插好，光标到尾注区去写；
  - 打的网址和 DOI 会存成可点击的链接。
- **尾注区**：默认在页面底部的“尾注”标签里。每一页、每天的日志、放大进去的块，一打开就有这个标签：先显示“尾注加载中…”，算好后是尾注区，没有尾注时是“本页无尾注”。排第几个在设置“尾注标签排第几个”里改（1 最前，打开页面默认显示它；0 最后），也可以直接在标签栏里拖动它。这个标签是插件画在界面上的，不往笔记里写任何东西；跳到文末、目录里的“编辑”会先把它切到前面。设置“尾注区位置”改成“正文末尾”，尾注区就回到页面末尾、Orca 原生“引用”区之前。导出页面时尾注区照旧在文末。每一行就是那条尾注本身，直接改：
  - 在一条末尾回车另起一行：按 Tab 就成了这条的批注；不按 Tab 直接写，行前马上显示 `[·]`，光标离开这一行，它就成为一条新尾注；
  - 在一条中间回车，会拆成两条；
  - 行前的 `[n]` 点一下回到正文里的引用处；没被引用的尾注显示 `[·]`。
- **编号**：按第一次被引用的位置编号，同一条多处引用共用一个编号。默认按当前打开的页面编号（放大进某个块时，按那个块）。在尾注区标题行的"归集"里可以往上绑定到某一层，这一层下面的所有页面统一编号；绑定以后，点别的章节的尾注会跳到那一章里的引用处。
- **目录**：默认是贴在编辑区右上方的抽屉，平时只有一列短线，没有边框。鼠标靠近时，附近几条带弹性浮出、上下撑开，最近一条显示编号和文字，停一会儿显示全文，正文里对应的上标同时亮起；点击跳到正文或文末（在设置里选），右键是这一条的操作。设置里可以改：动法（局部浮出 / 整条滑出）、浮动跟随（鼠标位置 / 阅读位置＋鼠标）、字体（跟随正文字体 / 西文衬线＋正文字体 / 无衬线）；也可以换回原来的列表浮窗（一行一条，可拖动、可锁定位置）。
- **删除**：
  - 把一条尾注的文字删光，再按一次退格，它就删掉了；
  - 在尾注区一行上用 Orca 的"删除块"，也是删除这条尾注；
  - 目录里每行的"…"里也能删除；
  - 会连带删掉正文里的上标时，先弹出确认框；
  - 空的尾注直接删掉，有内容的进"尾注回收站"页。在回收站里用块菜单→"插件命令"→"恢复尾注"恢复；在回收站里再删一次，就进"尾注待清理归档"，到期按设置清理；
  - 撤销一次就能把一次操作撤回。
- **设置**：都在 Orca 的插件设置页里，包括标签名、尾注区位置与“尾注”标签排第几个、尾注区样式、快捷键、目录样式（抽屉的动法、跟随、字体）与点击行为、可选的正文快速语法（如 `^^`）、归档保留天数。

在虎鲸笔记 1.100.0 上测试。“尾注”标签是插件画进 Orca 标签栏的，依赖 Orca 的界面结构；万一某次 Orca 更新后它不正常，可以先把“尾注区位置”改成“正文末尾”。

## 开发

```bash
npm ci
npm run types       # 下载 Orca 插件 API 的类型声明（只用于类型检查）
npm run typecheck
npm test
npm run package     # 生成 release/orca-footnotes-v<版本>.zip
```

把 `build/orca-footnotes` 复制到 Orca 的插件目录（`文档/orca/plugins/`），在 Orca 里启用即可。

`tests/real-orca/` 是在真实 Orca 里跑的测试：Orca 用 `--remote-debugging-port=9222` 启动（端口被占用时换一个，并设置 `OFN_CDP=http://127.0.0.1:<端口>`），只打开一个专门的测试库，并设置 `OFN_TEST_REPO=<测试库 id>`。如果打开的不是这个库，脚本什么都不做。`cdp-v3-flow`、`cdp-v32-jump`、`cdp-v32-more`、`cdp-v35-bin` 测的是列表目录，先用 `cdp-set-setting.mjs directoryStyle list` 切换。

代码结构：`src/v3/` 是插件本体，`src/vnext/` 和 `src/*.ts` 是沿用的公共部件与类型。

## 许可证

MIT

---

## English

Native footnotes for Orca Note. Citations in the text show as superscript numbers `[1]`; the footnotes sit in a 尾注 (Footnotes) tab beside Orca's references at the bottom of every page (or, by setting, at the end of the page); a drawer directory sits at the upper right. Each footnote is an ordinary native block tagged `#尾注` (the tag name can be changed in settings), so it can be searched, queried and @-referenced. A citation is a native reference to the footnote; the plugin only displays it as a number.

- **Add**: Ctrl+Alt+F (configurable), `/尾注`, or the toolbar button, then type the citation in place. Matching footnotes of this page are preselected; footnotes of other pages and any material in the library (Orca's own search) are offered below a divider. Choosing material creates a footnote that references it. Typed URLs and DOIs become links.
- **Footnote tab**: drawn by the plugin into Orca's bottom tab bar on every page from the first frame (loading… / none on this page), nothing written into your notes; its position is a setting and the tab can be dragged. Setting 尾注区位置 = 正文末尾 puts the footer back at the end of the page.
- **Footer**: every row is the footnote itself, edited directly. Enter at the end of a row starts a new footnote (Tab makes it a comment instead). `[n]` jumps back to the citation; uncited footnotes show `[·]`.
- **Numbering**: by first citation, per page (or zoomed block) by default; can be bound to an upper level so its pages share one numbering.
- **Directory**: a drawer of short lines at the upper right; near the pointer the entries spring out (nearest with its text, full text after a short rest). Settings: motion (local / whole column), follow (pointer / reading position + pointer), typeface (the note's own / Georgia + the note's / sans), or the old floating list.
- **Delete**: empty a footnote and press Backspace, or delete its footer row the Orca way. You are asked first when citations would be removed. Non-empty footnotes go to the recycle-bin page and can be restored from the block menu.

MIT License.
