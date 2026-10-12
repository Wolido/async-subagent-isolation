/**
 * 红阶段测试：`src/web/page.ts` —— 本地 web 视图的自包含页面（纯常量导出）。
 * 本轮用户定稿四件事中的页面契约（① 删 Final result 卡片 ② 去截断与
 * 「Load earlier」改客户端自动向前补齐）尚未实现，对应新契约用例预期红；
 * ③ 内联 marked + highlight.js、④ mermaid 不渲染的 vendor/渲染管线用例见
 * test/subagent-web-markdown.test.ts。
 *
 * 本轮信息架构 A（侧栏扁平化）+ B（深层页面面包屑与返回）红阶段契约：
 *   A. #tree-list 只渲染根节点：renderList(nodes) + renderTree() 内
 *      renderList(state.tree)，fillTree 退役；role=list/listitem；选中行 class
 *      active + aria-current="true"（aria-selected 退役，roving tabindex 保留）；
 *      行尾 childSummary(node.children) 聚合徽章（无 collapsed 门控，保留
 *      .child-summary 样式）；caret 折叠整组字面退役（sidebar 面板折叠保留）。
 *   B. 转录区包进 <section class="transcript-wrap">（内含 #crumbs nav 与
 *      #transcript）；renderCrumbs() 面包屑（← Back + 祖先段 + 当前段
 *      aria-current="page"，All tasks 根链节已退役）、goBack()、Alt+ArrowLeft
 *      返回；route() 与 renderTree() 均调用 renderCrumbs()。
 * 对应用例见文末「侧栏扁平化（A）」「深层页面面包屑与返回（B）」两组。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   export const PAGE_HTML: string   —— 单文件自包含 HTML（内联 <style> 与 <script>）
 *
 * 用例清单（编号对应验收清单 13–15）：
 *   13. PAGE_HTML 是字符串且含 <style> 与 <script>
 *   14. 不引用任何外部资源（<script src>/<link href>/<img src> 均不指向 http(s)://）
 *   15. 含 prefers-color-scheme（暗色适配）与 #/t/ 哈希路由标记（token 走 hash，
 *       不落服务端日志/Referer）
 *
 * Major-3 可观测契约（字符串级锁定，无 DOM 下只锁常量/文案标记）：
 *   16. var TREE_EVERY = 3;         —— 树刷新 3 秒（第 7 轮 D2 由 15 提速）
 *   17. var MAX_FAILURES = 5;       —— 连续失败 5 次才显示离线横幅（一次 404/网络
 *       失败不得永久离线）
 *   18. var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]; —— 指数退避
 *   19. "waiting for session file"  —— 会话文件尚未出现的等待态文案（继续轮询）
 *   20. 截断契约整体移除：MAX_ENTRIES / LOAD_BATCH / MAX_OLDER 与
 *       "Load earlier" / load-earlier 字面 0 命中；改为客户端自动向前补齐 ——
 *       backfillOlder 函数 + before 请求参数 + entriesStartOffset + topAnchor
 *   21. Final result 卡片整体移除：页面 7 处字面 0 命中，且 src/web/ 全目录
 *       文本不含 "Show more" / "Show less" / "Final result"（目录级守卫）
 *   22. 轮询 404 分支关键字 404 与 waiting 同时存在（不断言整段逻辑）
 *
 * 父子链接改指针后新增：
 *   23. "waiting for receipt"      —— unknown 节点（无收据、无指针，taskId 为空串）
 *       被点击时不改 hash、不发请求，只显示该等待态提示文案（字符串级锁定）
 *   24. dot-pending / pill-pending —— pending（等待收据）状态的树圆点与状态药丸
 *       都要有字面 class 名（与 tree 节点 status "pending" 对应）
 *
 * 侧栏收起改造（顶栏文字按钮 → 侧栏边缘图标按钮 + 正文区对等展开图标按钮，
 * 新契约，字符串级；像素级布局、Tab/Enter/Space 与点击交互需真实浏览器验证）：
 *   25. 顶栏不再含任何 sidebar 控件：id="sidebar-toggle" 与 "Hide sidebar" 字面 0 命中
 *   26. 侧栏 <aside id="tree"> 内顶部 <div class="sidebar-head"> 含图标折叠按钮
 *       id="sidebar-collapse"（class icon-btn，title/aria-label "Collapse sidebar"，
 *       aria-expanded="true"，aria-controls="tree"，图标 &#171;，仅图标无文字）
 *   27. 树渲染目标改为 <div id="tree-list" class="tree-list">
 *       （document.getElementById("tree-list")）
 *   28. 正文区有对等展开按钮 id="sidebar-expand"，DOM 位于 #transcript 之前
 *       （绝对定位，外观不变；class "icon-btn sidebar-expand"，"Expand sidebar"，
 *       初始 hidden，图标 &#187;）
 *   29. .icon-btn 样式：无边框、透明背景、hover 用 var(--tool)、focus-visible 有
 *       outline，且规则内 min-width: 28px; 与 min-height: 28px;（点击热区）
 *   30. sidebarState 逐字含 forceOpen；sidebarCollapsed() 窄窗口用 forceOpen 覆盖
 *       （无「收起后无法展开」死状态），不再给按钮设 disabled
 *   31. applySidebar() 同步两处 setAttribute("aria-expanded" 并用
 *       sidebarExpandEl.hidden 控制展开按钮可见性
 *   32. 两按钮各自 addEventListener("click", ...)（Tab/Enter/Space 由原生 button 承担，
 *       交互需浏览器验证）
 *   33. hidden 必须真正生效：.icon-btn 的 display: inline-flex 会压过 UA 的
 *       [hidden] { display: none }，页面 <style> 须自带守卫规则二选一 ——
 *       [hidden] { display: none !important; } 或 .icon-btn[hidden] { display: none; }
 *
 * 第 7 轮（cycle-2 前端红阶段）新契约用例分五组附于文末：
 *   C. /api/tree 消费对象形状 {apiVersion,nodes,truncated,expand}：refreshTree 取
 *      data.nodes（不再是裸数组）；state.truncated = data.truncated；
 *      #truncated-note（.truncated-note）在 truncated.dropped > 0 时显示精确
 *      文案 "显示最新 " + showing + " / 共 " + total，未截断隐藏。
 *   D1.（第 8 轮用户口径修订改写）侧栏日志式顺序（最旧在上、最新在下）：
 *       var LIST_NEWEST_FIRST = false;，renderList 默认按传入顺序渲染，
 *       反转仅在常量为真时发生（旧「必须倒序」断言已删除）。
 *   D2. var TREE_EVERY = 3;（树轮询 2–3 秒档，由 15 提速）；转录轮询
 *       var POLL_MS = 1000; 不变。
 *   E1. 页面 import API_VERSION（src/web/api-version.ts）并以字面量内联
 *       var PAGE_API_VERSION = 2;；/api/tree 与 /api/session 响应的 apiVersion
 *       与页面期望不一致 → 顶部 banner 精确文案
 *       "页面代码与后端不匹配，请刷新（⌘⇧R）"。
 *   E2. 右上角 #last-update（.last-update）：顶栏内常驻元素；原「成功文案
 *       "最后更新 " + N + "s 前"」契约已由本轮 A 修订 —— 健康态文本置空，
 *       仅失败态显示（.last-update.error + 原因，见本轮 A 组用例）。
 *   F. 远程图片不自动加载：renderMarkdown 对 img[src] 用内联的
 *      isAllowedImageSrc（src/web/markdown.ts 新导出，真值表用例见
 *      test/subagent-web-markdown.test.ts）白名单过滤；data: 与内部 /api/image
 *      保原样，其余替换为 .remote-image 占位（href 仅在原 src 通过 isSafeHref
 *      时设置 —— target="_blank" + rel="noopener noreferrer"、文本 alt||URL；
 *      javascript: / 空串等不通过的 src 不创建锚点、降级为纯文本占位），
 *      不留会自动请求的 img。
 *      _blank 相关既有守卫（C4/移除新标签打开）同步放宽：_blank 仅允许出现在
 *      与 noopener 同窗的占位锚点处，其余语义（new tab / open-new）仍 0 命中。
 *
 * 第 8 轮（用户口径修订，红阶段）用例两组：
 *   A（D1 改写）. 侧栏顺序改回日志式：var LIST_NEWEST_FIRST = false;
 *      （注释「用户口径：日志式，最新在底部」），renderList 内
 *      var list = LIST_NEWEST_FIRST ? nodes.slice().reverse() : nodes;
 *      默认按传入顺序（最旧在上）渲染，不反转。
 *   B. 打开页面时自动滚到最新（仅首次渲染）：同源内联 scrollTargetTaskId
 *      （src/web/tree-view.ts 新导出，真值用例见 test/subagent-web-tree-view.test.ts）、
 *      state.autoScrolledOnce / state.userScrolledSidebar、
 *      function autoScrollSidebar()（renderTree 挂行后调用）、boot 内 treeEl
 *      手动滚动监听、只写 treeEl.scrollTop、rowRect/listRect 视野内早退、
 *      深链优先调用点 scrollTargetTaskId(state.tree, state.taskId)。
 *
 * 独立审查缺口修复（第 7 轮后补，先修测试契约再修实现；对应新契约用例预期红）：
 *   契约 1（Critical 配套）. 远程图片占位锚点协议安全 —— 占位锚点的 href 仅在
 *      原 src 通过 isSafeHref（http:/https:/页内 #）时设置；不通过（尤其
 *      javascript:、空串）不创建锚点，降级为纯文本占位（span.remote-image 内
 *      只有文本）。旧 F 组「href=原 src 无条件赋值」契约作废并已改写。
 *   契约 3（Important 配套）. expand 去重标记生命周期 —— refreshTree 替换
 *      state.tree 时必须重置/失效 state.expanded（否则上次合并的 children
 *      丢失后该 taskId 永不重展开：合并结果永久丢失且不再请求）。
 *   契约 4. banner 优先级 —— state.mismatch 为真时，noteFailure/noteSuccess
 *      不得把 banner 文案改为连接/离线文案或清空（mismatch 横幅优先，持续
 *      显示「页面代码与后端不匹配，请刷新（⌘⇧R）」）。
 *
 * 本轮（冷深链面包屑 A / 药丸优先 B / 单行 32px C / 自动滚动小尾巴 E）红阶段
 * 契约四组，附于文末：
 *   A. 冷深链完整面包屑（服务端路径接口 + 客户端）：页面含字面 "/api/path"
 *      （GET /api/path?taskId=<id>）；state 新增 path: []、pathFound: null、
 *      pathTask: null、pathFor: null；function ensurePath( 经现有
 *      request("/api/path", { taskId }) 拉取，成功写入四字段后调用
 *      renderCrumbs() 与 updateStatus()，失败不重试成环；route() 命中 taskId
 *      时调用它。renderCrumbs()：state.pathFor === state.taskId 时用 state.path
 *      渲染每节（label = segment.task 或 id 前 8 位，dot 取 segment.status），
 *      否则回退现有 ancestorIds(state.tree, state.taskId)；当前节 label 取
 *      state.pathTask 或树节点；pathFor===taskId && pathFound===false 时追加
 *      .crumb-not-found（文本「未找到该任务」+ aria-current="page"）。
 *      goBack()：祖先链为空（depth≤1）时提前 return、不写 location.hash；
 *      非空时回直接上级（归一化链末节），仍以 location.hash 跳转（既有两条
 *      goBack 用例随此契约同步改写，覆盖不删）。
 *      任务不存在落点：pathFound===false 时转录区 .task-not-found 块（「未找到
 *      该任务」+ class="back-to-list" href="#/" 的「返回任务列表」链接），状态
 *      药丸同文案；切走其它路由时清除。
 *   B. failed/rejected 药丸优先：updateStatusPill 内 failed/rejected 判断位置
 *      早于 state.waiting 分支；class 为 pill-failed/pill-rejected、文本以状态开头。
 *   C. 行高单行 32px + 优先级降级：.node 必须 flex-wrap: nowrap 且高度 32px
 *      （min-height/height 任一，字面或 var(--sp-6)），保留 padding/line-height/
 *      gap；.task-line 继续省略号截断；.tree-list 加 container-type: inline-size
 *      与「单行 32px；降级顺序 耗时 → taskId 短码 → 聚合徽章；永不折行」注释；
 *      容器查询阈值固定：<420px 隐藏 .elapsed、<340px 隐藏 .tid、<260px 让
 *      .child-summary 省略号截断（max-width+overflow:hidden+text-overflow+
 *      white-space）。既有「.node 32px/20px/6px rhythm」用例按此同步改写。
 *   E. 自动滚动两个小尾巴：① 渲染行数为 0 不消耗一次性机会（autoScrolledOnce
 *      保持 false，「空 → 非空」仍自动滚一次，且该守卫先于任何消耗点）；
 *      ② treeEl.getBoundingClientRect().height === 0（侧栏折叠）不置
 *      autoScrolledOnce=true，改为记录待办；展开（expandSidebar()/applySidebar()
 *      变为展开）且 !state.userScrolledSidebar 时补一次 autoScrollSidebar()。
 *      B1–B8 既有用例（首行守卫、只写 scrollTop、手动停用、几何早退、深链优先）
 *      保留不删，新语义用例并入同组。
 *
 * 本轮（外链图片零请求 A / light recent 对比度 B / 树行 aria-label C）红阶段
 * 契约三组，附于文末：
 *   A. renderMarkdown 改为
 *      wrap.innerHTML = neutralizeRemoteMarkup(marked.parse(escapeRawHtml(value)))：
 *      同源内联 neutralizeRemoteMarkup.toString()（真值用例见
 *      test/subagent-web-markdown.test.ts 的 neutralizeRemoteMarkup 组），
 *      DOM sanitizer 消费 img[src], img[data-remote-src] 双选择器（remote 占位
 *      用 data-remote-src 原值构造 .remote-image）；F 组 img 选择器断言已放宽
 *      以同时接受旧单选择器与新双选择器。
 *   B. light :root 的 --st-recent-dot 与 --panel（#ffffff）WCAG 对比度 ≥3:1
 *      （从 PAGE_HTML 解析十六进制值计算，不锁字面值）；dark 块
 *      --st-recent-dot: #e3b341; 不得改动；原九令牌逐字用例中
 *      --st-recent-dot 的 #d9a032 字面锁已移除（对比度锁定取代）。
 *   C. renderList 的 .node 行带 aria-label，内容 <agent> · <status> · <duration>
 *      （" · " 分隔，取 node.agent / node.status / formatDuration(node)），
 *      可见文本节点不变。
 *
 * 本轮（徽章不折行 A / 退役 All tasks B / backTarget C / 正文链接新标签 E）
 * 红阶段契约四组，附于文末：
 *   A. 侧栏行内徽章不折行不溢出：.badge 规则须同时带 white-space: nowrap +
 *      overflow: hidden + text-overflow: ellipsis；.status-word / .tid /
 *      .elapsed 三条规则各自带 white-space: nowrap（.elapsed 文本含空格，如
 *      "1m 41s"）；.child-summary 既有 nowrap 保留（既有用例已锁，本组补
 *      回归断言）。三档宽度（320/480/700px）真实行高读数留给浏览器验证，
 *      本组只锁 CSS 契约。
 *   B. 面包屑退役 All tasks 根链节：PAGE_HTML 无 ">All tasks<" 文案、无
 *      <a class="crumb" href="#/"> 根链节（.back-to-list href="#/" 的未找到
 *      返回入口保留，不得误伤）；renderCrumbs() 不再插入该链节；结构契约 =
 *      祖先段 + 当前段（aria-current="page" 仍在当前段）；.dot-root CSS 保留
 *      （祖先/当前节状态点兜底）。原「All tasks 根链节逐字」用例已删除，由
 *      本组替代。
 *   C. ← Back 仅 depth ≥ 2（祖先链非空）出现：src/web/tree-view.ts 新导出
 *      backTarget(path, ancestors)（真值用例见
 *      test/subagent-web-tree-view.test.ts），页面内联 function backTarget(；
 *      renderCrumbs() 内 Back 按钮插入受祖先链非空守卫；goBack() 祖先链为空
 *      时提前 return、不写 location.hash（深度 ≤1 时 Alt+← 无动作）。
 *   E. 正文来源链接新标签页打开：renderMarkdown 的 a[href] 处理段对 http(s)
 *      href 设 target="_blank" + noopener rel（页内 # 锚点不设 target，target
 *      赋值位于 http(s) 判断分支内）；isSafeHref 白名单仍在 target 写入之前；
 *      远端图片占位锚点（F 组）与内部导航项（subagent nav / 面包屑）的既有
 *      契约不变；_blank 守卫放行规则 =「每处 _blank ±300 字符窗口内含
 *      noopener」，正文链接同走这条放行规则。
 *
 * 本轮（最后更新只在失败态 A / 状态药丸移位 B / 图例退役 C / elapsed 溢出兜底 D）
 * 红阶段契约四组，附于对应分组：
 *   A. 删除「最后更新 Ns 前」常显文案与「等待数据」文案：PAGE_HTML 不再含
 *      "最后更新 " 字面、不含 >等待数据<；#last-update 元素与 .last-update /
 *      .last-update.error CSS 保留；健康态（无失败）updateLastUpdate 把
 *      #last-update 文本置空（textContent = ""）且 class 不含 error；失败态
 *      不变（class="last-update error" + 文案「更新失败（…）」含原因）。
 *   B. 状态药丸移到转录区右上角、区域内吸顶：顶栏 .topbar 片段不再含
 *      id="status"；id="status" class="pill" 移入 .transcript-wrap，包在
 *      <div class="transcript-head"> 里，位于 #crumbs 之后、#transcript 之前；
 *      新增 .transcript-head CSS 规则（position: sticky、top: 0、
 *      justify-content: flex-end、background: var(--panel)，pill 右边缘与
 *      .transcript-wrap 右边缘对齐 —— 右内边距为 0）；内容与更新逻辑不变
 *      （status | duration），updateStatusPill 仍操作 #status（既有文本逻辑
 *      用例保留不动）。
 *   C. 删除侧栏顶部图例：.legend / .legend-item 标记与 CSS 全部退役，
 *      #tree-list 上方不再有六个状态词图例文本；行内 .dot（aria-hidden）与
 *      .status-word / .status-* 保留，aria-hidden 断言收紧到 .dot 创建处
 *      （el("span", "dot…") + setAttribute("aria-hidden", "true")），
 *      不得再靠 legend 容器通过。
 *   D. .elapsed 极端耗时溢出兜底：规则新增 max-width 与 overflow: hidden /
 *      text-overflow: ellipsis（保留 white-space: nowrap、flex-shrink: 0）。
 *
 * 本轮 A 谱系高亮（红阶段，字符串级，附于文末「深任务谱系高亮（A）」组）：
 *   A1. src/web/tree-view.ts 新导出 lineageRowId / lineageLabel 并经
 *       ${…toString()} 内联 —— PAGE_HTML 含 function lineageRowId( 与
 *       function lineageLabel(；
 *   A2. highlightSelection() 用 lineageRowId(state.taskId,
 *       state.pathFor === state.taskId ? state.path : [],
 *       ancestorIds(state.tree, state.taskId)) 求 rowId，仅按
 *       rows[i].dataset.taskId === rowId 匹配选中行（active +
 *       aria-current="true" 全局唯一，其余行移除）；祖先行不在已加载列表
 *       （被截断）时不匹配任何行 → 0 行高亮，不得回退高亮别的行；
 *   A3. rowId !== state.taskId（即 depth ≥ 2）时在选中行尾部挂
 *       <span class="lineage">，文本 lineageLabel(<当前节点 agent>,
 *       state.taskId)，当前节点取 state.pathTask || findNode(state.tree,
 *       state.taskId)（agent 缺失回退 "subagent"）；depth 1 时移除该行
 *       .lineage（无后缀）；
 *   A4. ensurePath() 成功回调在 renderCrumbs() 之后调用 highlightSelection()
 *       （path 到达即高亮/后缀生效，失败回调保持已清除态）；
 *   A5. CSS 新增 .lineage 规则（浏览器实测两轮修订后的定稿：无下限的
 *       flex: 0 1 auto 会把后缀压到 ~0.6px 不可读，改 flex: 0 0 auto 固定宽又会
 *       挤掉相邻列 —— 最终采用「可收缩但有区间钳制」）：flex: 0 1 auto /
 *       min-width: 6em（收缩下限，防压到 ~0）/ max-width: 9em（上限）/
 *       white-space: nowrap / overflow: hidden / text-overflow: ellipsis；
 *       既有 @container (max-width: 239px) 降级块内保留 .lineage { display: none; }
 *       （极窄窗整体省略）；@container (max-width: 340px) 块内保留让位规则
 *       .node:has(.lineage) .tid / .elapsed / .child-summary { display: none; }
 *       （带后缀的行先让出 taskId 短码 / 耗时 / 聚合徽章；色点、badge、task-line、
 *       后缀保留，badge 恢复完整不再收缩）；宽侧栏 @container (min-width: 441px) {
 *       .lineage { max-width: 12em } } 为可选放宽，本组不锁断言；
 *   A6. 回归锁（天然绿）：行点击仍 activateRow(node, …) 以 node.taskId 写
 *       location.hash（切到该 depth-1 任务）；autoScrollSidebar 仍调
 *       scrollTargetTaskId(state.tree, state.taskId)，不改用 lineage。
 *
 * 本轮（.reason 退役 A / rejected-耗时不累积 B）红阶段契约两组，附于对应分组：
 *   A. 行内不再显示拒绝原因：renderList 删除 .reason 元素创建与 node.reason
 *      追加、.reason CSS 规则退役（PAGE_HTML 不含 class="reason"）；行保留
 *      状态点 + 状态词 + agent 徽章 + taskId 短码 + 耗时 + 任务文本 + 聚合徽章；
 *      拒绝原因不丢 —— node.reason 作为行 title（一句摘要）；点击该行仍切换
 *      既有 .node-error 面板，面板内同时展示 node.reason 与完整 node.errorText；
 *      errorEl 创建与 click/keydown 判定放宽为 node.errorText || node.reason
 *      （仍是「有错误 → 切面板、不导航」）。既有冲突用例（.reason 行内展示、
 *      .reason 规则 flex-basis 断言、mount-the-reason 断言）随契约改写。
 *   B. 终态耗时不累积：src/web/tree-view.ts 新导出 durationMs(node, nowMs)
 *      （真值用例见 test/subagent-web-tree-view.test.ts），页面经 ${…toString()}
 *      内联 —— PAGE_HTML 含 function durationMs(；formatDuration 改为
 *      var ms = durationMs(node, Date.now()); return ms === null ? "—" :
 *      formatMs(ms)：rejected/failed/finished 缺 finishedAt → "—"（绝不随
 *      Date.now() 变化），pending/running 保持随时间累积。
 *
 * 本轮（容器 340–440px 区间宽 badge 溢出，A）红阶段契约一组，附于文末
 * 「340–440px 区间徽章收紧（本轮 A）」组：
 *   A. 既有 @container (max-width: 340px) 块只收紧 ≤340px；340–440px 区间
 *      无任何收紧，宽 badge（engineer-legion ≈100px）带谱系后缀行在该区间
 *      横向溢出。新增 @container (min-width: 340px) and (max-width: 440px)
 *      块（下界 340px 与 ≤340 块在 340 处重叠，消除 340<x<341 的小数死区），
 *      内容与 340 块相同：.badge { max-width: 9.2em; } 与三条
 *      .node:has(.lineage) .tid/.elapsed/.child-summary { display: none; }
 *      让位规则（断言用花括号配平限定在该块内）。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"；纯常量断言，无 fixture、无网络。
 */

import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../src/web/page.ts";
import { ancestorIds, backTarget, childSummary, crumbLabel, scrollTargetTaskId } from "../src/web/tree-view.ts";
import { HIGHLIGHT_JS, MARKED_JS } from "../src/web/vendor.ts";

describe("PAGE_HTML 自包含页面", () => {
	it("should be a string containing inline <style> and <script> blocks", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert
		expect(typeof PAGE_HTML).toBe("string");
		expect(PAGE_HTML).toMatch(/<style[\s>]/);
		expect(PAGE_HTML).toMatch(/<script[\s>]/);
	});

	it("should not reference any external http(s) resource via script src, link href or img src", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 三类外部资源引用一律禁止（页面必须离线单文件可用）
		expect(PAGE_HTML).not.toMatch(/<script[^>]*\ssrc\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<link[^>]*\shref\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<img[^>]*\ssrc\s*=\s*["']https?:\/\//i);
	});

	it("should include prefers-color-scheme and the #/t/ hash route marker", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 暗色适配 + 哈希路由标记
		expect(PAGE_HTML).toContain("prefers-color-scheme");
		expect(PAGE_HTML).toContain("#/t/");
	});
});

// ---------------------------------------------------------------------------
// Major-3 可观测契约（字符串级锁定，见文件头 16–22）
// ---------------------------------------------------------------------------

describe("PAGE_HTML Major-3 可观测契约（常量/文案标记）", () => {
	it("should declare the tree refresh constant as the exact literal var TREE_EVERY = 3;", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 树刷新 3 秒（逐字，第 7 轮 D2 由 15 秒提速到 2–3 秒档）
		expect(PAGE_HTML).toContain("var TREE_EVERY = 3;");
		// TREE_EVERY 以秒为单位：tick() 里乘 1000 后与 Date.now() 差值比较
		expect(PAGE_HTML).toContain("TREE_EVERY * 1000");
	});

	it("should keep the transcript poll interval at the exact literal var POLL_MS = 1000;", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 转录轮询节奏不受树轮询提速影响，仍为 1000ms（逐字）
		expect(PAGE_HTML).toContain("var POLL_MS = 1000;");
	});

	it("should declare the offline threshold constant as the exact literal var MAX_FAILURES = 5;", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 连续失败 5 次才显示离线横幅（逐字），一次 404/网络失败不得永久离线
		expect(PAGE_HTML).toContain("var MAX_FAILURES = 5;");
	});

	it("should declare the exponential backoff array as the exact literal var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 指数退避常量数组（逐字）
		expect(PAGE_HTML).toContain("var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];");
	});

	it("should contain the waiting-state copy 'waiting for session file' when the session file has not appeared yet", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 等待态文案（会话文件未出现时显示并继续轮询）
		expect(PAGE_HTML).toContain("waiting for session file");
	});

	it("should contain the waiting-state copy 'waiting for receipt' for nodes without a receipt or pointer link", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: unknown 节点（无收据、无指针，taskId 为空串）被点击时——不改
		// hash、不发请求——只显示该等待态提示文案
		expect(PAGE_HTML).toContain("waiting for receipt");
	});

	it("should render the pending (waiting-for-receipt) node state via the literal dot-pending and pill-pending class names", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 树节点圆点与状态药丸都要有 pending（等待收据）态的字面 class，
		// 与 tree 节点 status "pending" 对应
		expect(PAGE_HTML).toContain("dot-pending");
		expect(PAGE_HTML).toContain("pill-pending");
	});

	it("should not declare the truncation constants MAX_ENTRIES, LOAD_BATCH or MAX_OLDER", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 转录截断/批次上限常量整体移除 —— 不再在 DOM 侧截断，
		// 改为客户端自动向前补齐（新契约见下一组用例）
		expect(PAGE_HTML).not.toContain("MAX_ENTRIES");
		expect(PAGE_HTML).not.toContain("LOAD_BATCH");
		expect(PAGE_HTML).not.toContain("MAX_OLDER");
	});

	it("should have removed the 'Load earlier' control copy and its load-earlier button class", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 「加载更早」控件与按钮 class 整体移除（字面 0 命中）
		expect(PAGE_HTML).not.toContain("Load earlier");
		expect(PAGE_HTML).not.toContain("load-earlier");
	});

	it("should keep both the '404' and 'waiting' keywords present for the poll 404 continuation branch", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 404 分支关键字同时存在（不断言整段逻辑；waiting 即继续轮询的延续态）
		expect(PAGE_HTML).toContain("404");
		expect(PAGE_HTML).toContain("waiting");
	});
});

// ---------------------------------------------------------------------------
// 用户定稿之二：截断与「Load earlier」移除，改为客户端自动向前补齐
// （backfillOlder + before 请求参数 + entriesStartOffset + topAnchor）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 客户端自动向前补齐（新契约，字符串级锁定）", () => {
	it("should auto-backfill older transcript entries through the literal backfillOlder function", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 补齐入口函数名逐字 —— 滚动到转录顶部时客户端自动拉取更早条目
		expect(PAGE_HTML).toContain("backfillOlder");
	});

	it("should send the 'before' cursor parameter when requesting older transcript entries", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 请求参数名逐字 —— 对象写法 `before:` 或字符串写法 `"before"`
		// 任一（与既有 request(pathname, params) 查询串拼装方式兼容）
		expect(PAGE_HTML).toMatch(/before:|"before"/);
	});

	it("should track the transcript start offset and the top anchor used for backfill", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 已加载条目的起始偏移 + 转录顶部锚点（补齐后插入位置）两个标识逐字
		expect(PAGE_HTML).toContain("entriesStartOffset");
		expect(PAGE_HTML).toContain("topAnchor");
	});
});

// ---------------------------------------------------------------------------
// 用户定稿之一：图片懒加载占位卡片（Final result 卡片整体移除，见下一组）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 图片懒加载占位卡片（字符串级契约）", () => {
	it("should render images as placeholder cards with the literal image-block and image-meta classes and 'Load image' copy", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 占位卡片的字面 class 名与点击加载文案（逐字）
		expect(PAGE_HTML).toContain("image-block");
		expect(PAGE_HTML).toContain("image-meta");
		expect(PAGE_HTML).toContain("Load image");
	});

	it("should contain the image load failure copy 'Failed to load image'", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 拉取 /api/image 失败时的文案（逐字）
		expect(PAGE_HTML).toContain("Failed to load image");
	});

	it("should request /api/image on demand via URL.createObjectURL instead of embedding base64 in the DOM", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 点击后才请求的端点路径 + blob URL 生成 API；页面不内嵌 data: 图片
		expect(PAGE_HTML).toContain("/api/image");
		expect(PAGE_HTML).toContain("URL.createObjectURL");
		expect(PAGE_HTML).not.toContain("data:image/");
	});

	it("should remain a self-contained page without external http(s) resources", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 新增卡片不得引入外部资源（写法同既有 14 号用例）
		expect(PAGE_HTML).not.toMatch(/<script[^>]*\ssrc\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<link[^>]*\shref\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<img[^>]*\ssrc\s*=\s*["']https?:\/\//i);
	});
});

// ---------------------------------------------------------------------------
// 用户定稿之一：Final result 卡片彻底移除（页面字面 + src/web/ 目录级守卫）
// ---------------------------------------------------------------------------

describe("PAGE_HTML Final result 卡片整体移除（字符串级 + 目录级守卫）", () => {
	it("should have removed every Final result card literal from the page", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 卡片文案 / 展开收起按钮 / 复制按钮 / 卡片与按钮 class 全部字面 0 命中
		expect(PAGE_HTML).not.toContain("Final result");
		expect(PAGE_HTML).not.toContain("No final result yet");
		expect(PAGE_HTML).not.toContain("Show more");
		expect(PAGE_HTML).not.toContain("Show less");
		expect(PAGE_HTML).not.toContain("final-card");
		expect(PAGE_HTML).not.toContain("final-toggle");
		expect(PAGE_HTML).not.toContain("final-copy");
	});

	it("should keep the whole src/web/ directory free of the Final result card copy", async () => {
		// Arrange: 动态 import node 内置模块（沿用本文件 _blank 目录级守卫写法）
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const webDir = fileURLToPath(new URL("../src/web/", import.meta.url));
		const copy = ["Show more", "Show less", "Final result"];

		// Act: 逐文件 grep 三条卡片文案（含注释 —— 该卡片语义整体退役）
		const offenders = fs
			.readdirSync(webDir)
			.filter((name: string) => name.endsWith(".ts"))
			.filter((name: string) => {
				const text = fs.readFileSync(path.join(webDir, name), "utf-8");
				return copy.some((needle) => text.includes(needle));
			});

		// Assert: src/web/ 全目录 0 处命中
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 追加：blob URL 回收与 imageRef 防御分支（字符串级契约）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 图片 blob URL 生命周期与 imageRef 防御分支（字符串级契约）", () => {
	it("should release previously created image blob URLs via URL.revokeObjectURL", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 切任务 / 清理转录 / 淘汰旧 entry 时回收已加载图片的
		// blob URL，否则大会话多图场景下浏览器内存只增不减。实现已提供
		// releaseImages()（内部调用 URL.revokeObjectURL），本用例锁定该契约。
		expect(PAGE_HTML).toContain("revokeObjectURL");
	});

	it("should keep loading images through URL.createObjectURL", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 回收机制不得改掉既有加载路径（与上一条成对锁定）
		expect(PAGE_HTML).toContain("URL.createObjectURL");
	});

	it("should only show the clickable 'Load image' button under an imageRef existence guard", () => {
		// 字符串级锁定（无 DOM 下无法行为级断言「按钮不渲染」）。判据 = 按钮
		// 创建发生在 imageRef 判空之后，或调用点（renderContent 的 image 分支）
		// 先判 imageRef 再创建块，或按钮仅在 imageRef 守卫内才挂到 DOM ——
		// 三种合法形状任一即通过；三者都刻意加了边界（imageBlock 起点 /
		// 200+160 字符 / 400 字符），避免与「无守卫、按钮无条件创建」的形状
		// 意外匹配。现实现已以形状①落地：imageBlock 内先取
		// var ref = part.imageRef || {} 判空，缺失时渲染 "image not available"
		// 占位并提前 return（按钮创建、append 均在其后）—— 本用例锁定该形状，
		// 即「无 imageRef 的块不显示可点击按钮」的契约。
		// 局限：其它能达成行为的写法（如创建后用无关变量名判空隐藏）不在
		// 判据内，若实现改写为那些形状需按实际形状补一条替代判据。
		const guardShapes = [
			/function imageBlock\(part\)[\s\S]*?imageRef[\s\S]*?"Load image"/,
			/part\.type === "image"[\s\S]{0,200}?imageRef[\s\S]{0,160}?imageBlock\(part\)/,
			/imageRef[\s\S]{0,400}?appendChild\(button\)/,
		];
		expect(guardShapes.some((shape) => shape.test(PAGE_HTML))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 用户反馈四条修复之三（C 组，字符串级契约）：subagent 转录导航项、侧栏
// 收起/调宽、点击后立即高亮、移除新标签打开。实现尚未落地，本组预期红。
// 契约摘要：
//   C1. 转录里的 subagent 工具调用渲染为可点导航项：容器 class subagent-nav
//       带 data-toolcall-id；有 link 时渲染 a.subagent-link，href =
//       "#/t/" + encodeURIComponent(childTaskId)，文案形如 "→ open <agent>
//       (<status>)"（逐字含 "→ open "），不得有 target/_blank；无 link 时显示
//       "waiting for receipt" 不可点；每次 /api/session 轮询后读取 result.links
//       并调用升级函数（applyNavLinks）。
//   C2. 侧栏收起/调宽：常量、localStorage 键、元素 id、CSS 类/变量、分隔条
//       键盘可达（role="separator" + ArrowLeft/ArrowRight）、窄窗口自动收起。
//   C3. 点击后立即高亮（乐观更新）：highlightSelection 函数存在，树行写
//       data-task-id（等价 dataset.taskId），route() 设置 state.taskId 后同步调用。
//   C4. 移除新标签打开："new tab" / open-new 全字面 0 命中；_blank 仅允许出
//       现在与 noopener 同窗（±300 字符）的两处 —— 远程图片占位锚点构造处
//       （第 7 轮 F 组契约）与 renderMarkdown 正文来源链接的 target 赋值处
//       （本轮 E 契约），src/web/ 目录级守卫同规则。
// ---------------------------------------------------------------------------

describe("PAGE_HTML subagent 转录导航项（字符串级契约）", () => {
	it("should render a nav container with the literal subagent-nav class and data-toolcall-id attribute", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 每个 subagent 工具调用旁的导航容器 —— class 与数据属性逐字
		expect(PAGE_HTML).toContain("subagent-nav");
		expect(PAGE_HTML).toContain("data-toolcall-id");
	});

	it("should render the clickable anchor with the literal subagent-link class and the '→ open ' copy prefix", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 可点链接 class（逐字）+ 文案前缀 "→ open "（逐字，含尾随空格）
		expect(PAGE_HTML).toContain("subagent-link");
		expect(PAGE_HTML).toContain("→ open ");
	});

	it("should build the nav href from the #/t/ hash route plus the encoded childTaskId", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: href = "#/t/" + encodeURIComponent(childTaskId) —— 同页哈希切换，
		// token 不经 Referer 泄露；要求编码目标为 childTaskId（避免被既有树行的
		// TASK_PREFIX + encodeURIComponent(node.taskId) 误判通过）
		expect(PAGE_HTML).toMatch(/#\/t\/" \+ encodeURIComponent\(|TASK_PREFIX \+ encodeURIComponent\([^)]*childTaskId[^)]*\)/);
	});

	it("should not open the subagent nav link in a new tab (no target assignment on the nav anchor)", () => {
		// Arrange: navAnchor 的函数体片段（subagent 导航锚点创建处）
		const nav = fnBody("navAnchor");

		// Assert: 导航项同页切换 —— 导航锚点上不设 target、不出现 _blank。
		// 全局 _blank 仅放行于第 7 轮 F 组的远程图片占位锚点（另有用例锁定），
		// 此处只锁导航锚点本身不得新标签打开。
		expect(nav).not.toMatch(/\.target\s*=/);
		expect(nav).not.toMatch(/setAttribute\(\s*["']target["']/);
		expect(nav).not.toContain("_blank");
	});

	it("should keep the existing 'waiting for receipt' copy for toolCalls without receipt or pointer link", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 收据与指针都没有时的等待态文案（不可点）复用既有逐字文案
		expect(PAGE_HTML).toContain("waiting for receipt");
	});

	it("should read the links array from each /api/session poll response and call an upgrade function on the nav items", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 字符串级锁定两点 —— 轮询响应里的 links 被读取（result.links /
		// state.links 至少其一），且存在 applyNavLinks(...) 调用点（既有等待态
		// 导航项拿到收据后升级为可点）；「调用后真实变可点」的时序只能靠真实
		// 浏览器验证，此处仅锁调用点存在
		expect(PAGE_HTML).toMatch(/result\.links|state\.links/);
		expect(PAGE_HTML).toMatch(/applyNavLinks\([^)]*\)\s*;/);
	});
});

describe("PAGE_HTML 侧栏收起/调宽（字符串级契约）", () => {
	it("should declare the sidebar constants as the exact literals SIDEBAR_MIN = 200, SIDEBAR_MAX_RATIO = 0.6, NARROW_MAX = 700, SIDEBAR_STEP = 16", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 四个常量逐字（最小宽 200、最大宽比 0.6、窄窗口阈值 700、键盘步进 16）
		expect(PAGE_HTML).toContain("var SIDEBAR_MIN = 200;");
		expect(PAGE_HTML).toContain("var SIDEBAR_MAX_RATIO = 0.6;");
		expect(PAGE_HTML).toContain("var NARROW_MAX = 700;");
		expect(PAGE_HTML).toContain("var SIDEBAR_STEP = 16;");
	});

	it("should persist sidebar state under the exact localStorage keys asi-sidebar-collapsed and asi-sidebar-width", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: localStorage 键逐字（刷新后保持收起/宽度）
		expect(PAGE_HTML).toContain("asi-sidebar-collapsed");
		expect(PAGE_HTML).toContain("asi-sidebar-width");
	});

	it("should contain the literal element id splitter (drag handle)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 拖拽分隔条的元素 id 逐字保留。旧的顶栏文字按钮 sidebar-toggle
		// 已由「侧栏边缘图标折叠按钮 + 正文区对等展开按钮」取代，旧断言不保留，
		// 新契约见下一组「侧栏边缘图标按钮收起/展开」。
		expect(PAGE_HTML).toContain("splitter");
	});

	it("should toggle the collapsed state via the literal .layout.sidebar-collapsed class and the --sidebar-width CSS variable", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: CSS 契约 —— 收起态 class 与宽度变量逐字
		expect(PAGE_HTML).toContain(".layout.sidebar-collapsed");
		expect(PAGE_HTML).toContain("--sidebar-width");
	});

	it("should make the drag handle keyboard-reachable via role=separator with ArrowLeft and ArrowRight handling", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 手柄键盘可达 —— 分隔条 role + 左右方向键处理（步进 SIDEBAR_STEP）
		expect(PAGE_HTML).toContain("role=\"separator\"");
		expect(PAGE_HTML).toContain("ArrowLeft");
		expect(PAGE_HTML).toContain("ArrowRight");
	});

	it("should exclude altKey from the splitter ArrowLeft/ArrowRight resizing so Alt+ArrowLeft never resizes and goes back at once", () => {
		// Arrange: splitter 的 keydown 监听窗口（起 900 字符 —— 整个 handler 约
		// 600 字符，窗口覆盖全部分支；其后仅触及 resize 监听，不含 altKey）
		const start = PAGE_HTML.indexOf('splitterEl.addEventListener("keydown"');
		expect(start, "missing splitter keydown handler").toBeGreaterThan(-1);
		const splitterKey = PAGE_HTML.slice(start, start + 900);

		// Assert: 左右键调宽分支必须先排除 altKey（否则 splitter 聚焦时
		// Alt+← 会同时调宽侧栏并冒泡触发 document 级 goBack）
		expect(splitterKey).toContain("altKey");
		expect(splitterKey).toMatch(/!(?:event|e)\.altKey/);
	});

	it("should auto-collapse the sidebar under the literal narrow check window.innerWidth < NARROW_MAX", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 窄窗口自动收起判据（逐字比较表达式）
		expect(PAGE_HTML).toContain("window.innerWidth < NARROW_MAX");
	});
});

// ---------------------------------------------------------------------------
// 侧栏收起改造：顶栏文字按钮 → 侧栏边缘图标按钮 + 正文区对等展开图标按钮
// （新契约，字符串级；像素级布局、Tab/Enter/Space 键盘可达与点击交互无法在
// vitest/node 环境验证，需真实浏览器）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 侧栏边缘图标按钮收起/展开（字符串级契约）", () => {
	it("should remove the old topbar text toggle: no id=\"sidebar-toggle\" literal and no 'Hide sidebar' copy", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 旧文字按钮的元素 id 与文案字面 0 命中
		expect(PAGE_HTML).not.toContain('id="sidebar-toggle"');
		expect(PAGE_HTML).not.toContain("Hide sidebar");
	});

	it("should keep the topbar free of any sidebar control and of the relocated status pill", () => {
		// Arrange: 用 class="topbar" ... </header> 抽出顶栏片段
		const topbar = PAGE_HTML.match(/class="topbar"[\s\S]*?<\/header>/)?.[0] ?? "";

		// Assert: 顶栏片段存在且不含任何 sidebar 字样（按钮已移出顶栏）
		expect(topbar).not.toBe("");
		expect(topbar).not.toContain("sidebar");

		// Assert（本轮 B，当前应红）: 状态药丸移出顶栏 —— 顶栏片段不再含
		// id="status"（元素迁往 .transcript-head，见本轮 B 组用例）
		expect(topbar, "the status pill must leave the topbar").not.toContain('id="status"');
	});

	it("should render the collapse button inside the <aside id=\"tree\"> sidebar-head container", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 折叠按钮在侧栏 aside 内部，且由 sidebar-head 容器包裹
		expect(PAGE_HTML).toMatch(/<aside[^>]*id="tree"[\s\S]*?id="sidebar-collapse"/);
		expect(PAGE_HTML).toMatch(/<div class="sidebar-head">[\s\S]*?id="sidebar-collapse"/);
	});

	it("should define the collapse button as an icon-only icon-btn with the verbatim 'Collapse sidebar' title and aria attributes", () => {
		// Arrange: 抽出折叠按钮的开标签与整个按钮块
		const tag = PAGE_HTML.match(/<button[^>]*id="sidebar-collapse"[^>]*>/)?.[0] ?? "";
		const block = PAGE_HTML.match(/<button[^>]*id="sidebar-collapse"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

		// Assert: 属性逐字（class/type/title/aria-label/aria-expanded/aria-controls），
		// 断言属性各自存在而非整段匹配，避免属性书写顺序造成的误伤
		expect(tag).not.toBe("");
		expect(tag).toContain('class="icon-btn"');
		expect(tag).toContain('type="button"');
		expect(tag).toContain('title="Collapse sidebar"');
		expect(tag).toContain('aria-label="Collapse sidebar"');
		expect(tag).toContain('aria-expanded="true"');
		expect(tag).toContain('aria-controls="tree"');

		// Assert: 图标 «（&#171;）且仅图标无文字（文字内容为空串）
		expect(block).not.toBe("");
		expect(block).toContain("&#171;");
		const visibleText = block
			.replace(/<button[^>]*>/, "")
			.replace(/<\/button>/, "")
			.replace("&#171;", "")
			.trim();
		expect(visibleText).toBe("");
	});

	it("should place the expand button before #transcript in the main content area", () => {
		// Arrange: 两个元素 id 字面的出现位置索引
		const transcriptIdx = PAGE_HTML.indexOf('id="transcript"');
		const expandIdx = PAGE_HTML.indexOf('id="sidebar-expand"');

		// Assert（新规格，语义反转）: 展开按钮 DOM 位于 #transcript 之前
		// （绝对定位到正文区左上角，外观不变），故 expandIdx < transcriptIdx
		expect(transcriptIdx).toBeGreaterThan(-1);
		expect(expandIdx).toBeGreaterThan(-1);
		expect(expandIdx).toBeLessThan(transcriptIdx);
	});

	it("should define the expand button as an icon-only icon-btn with the verbatim 'Expand sidebar' title, aria attributes and the hidden attribute", () => {
		// Arrange: 抽出展开按钮的开标签与整个按钮块
		const tag = PAGE_HTML.match(/<button[^>]*id="sidebar-expand"[^>]*>/)?.[0] ?? "";
		const block = PAGE_HTML.match(/<button[^>]*id="sidebar-expand"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

		// Assert: 属性逐字，初始 hidden（收起态隐藏），aria-expanded 与折叠按钮对等
		expect(tag).not.toBe("");
		expect(tag).toContain('class="icon-btn sidebar-expand"');
		expect(tag).toContain('type="button"');
		expect(tag).toContain('title="Expand sidebar"');
		expect(tag).toContain('aria-label="Expand sidebar"');
		expect(tag).toContain('aria-expanded="false"');
		expect(tag).toContain('aria-controls="tree"');
		expect(tag).toContain("hidden");

		// Assert: 图标 »（&#187;）且仅图标无文字
		expect(block).not.toBe("");
		expect(block).toContain("&#187;");
		const visibleText = block
			.replace(/<button[^>]*>/, "")
			.replace(/<\/button>/, "")
			.replace("&#187;", "")
			.trim();
		expect(visibleText).toBe("");
	});

	it("should render the tree into the #tree-list container instead of #tree", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 渲染目标子容器的字面标签 + JS 取该容器（而非 aside 本体）
		// 契约 A.2：#tree-list 还要带 role="list"（静态属性或 boot 内 setAttribute
		// 二选一），故不再锁整段裸标签字面，改为抽标签后断言 class
		const treeListTag = PAGE_HTML.match(/<div[^>]*id="tree-list"[^>]*>/)?.[0] ?? "";
		expect(treeListTag).not.toBe("");
		expect(treeListTag).toContain('class="tree-list"');
		expect(PAGE_HTML).toContain('document.getElementById("tree-list")');
	});

	it("should style .icon-btn as a borderless transparent icon button with a var(--tool) hover and a focus-visible outline", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 类名存在 + 四条样式判据（书写格式宽容：允许 border:none/0、
		// 无空格压缩写法；hover/focus-visible 可为组合选择器）
		expect(PAGE_HTML).toContain(".icon-btn");
		expect(PAGE_HTML).toMatch(/\.icon-btn\s*\{[^}]*border\s*:\s*(?:none|0)\b/);
		expect(PAGE_HTML).toMatch(/\.icon-btn\s*\{[^}]*background\s*:\s*transparent/);
		expect(PAGE_HTML).toMatch(/\.icon-btn:hover[^{]*\{[^}]*var\(--tool\)/);
		expect(PAGE_HTML).toMatch(/\.icon-btn:focus-visible[^{]*\{[^}]*outline/);
	});

	it("should give .icon-btn a click target of 28×28 via min-width and min-height", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 点击热区统一 28×28 —— 两条声明都要在 .icon-btn 规则内
		expect(PAGE_HTML).toMatch(/\.icon-btn\s*\{[^}]*min-width:\s*28px;/);
		expect(PAGE_HTML).toMatch(/\.icon-btn\s*\{[^}]*min-height:\s*28px;/);
	});

	it("should declare sidebarState with the exact literal including forceOpen", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 状态对象逐字（含窄窗口强制展开位 forceOpen）
		expect(PAGE_HTML).toContain("var sidebarState = { userCollapsed: false, width: 280, forceOpen: false };");
	});

	it("should let forceOpen override the narrow-window auto-collapse inside sidebarCollapsed()", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: sidebarCollapsed() 函数体内引用 forceOpen —— 窄窗口下用户仍可
		// 展开侧栏，不出现「收起了且无法展开」的死状态（真实展开行为需浏览器验证）
		expect(PAGE_HTML).toMatch(/function sidebarCollapsed\(\)\s*\{[\s\S]{0,300}?forceOpen/);
	});

	it("should not disable the sidebar buttons (no .disabled assignments on the collapse/expand elements)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 旧的窄窗口 disabled 路径不再出现 —— 两个新按钮都不得被设 disabled
		expect(PAGE_HTML).not.toMatch(/sidebarCollapseEl\.disabled\s*=|sidebarExpandEl\.disabled\s*=/);
	});

	it("should sync aria-expanded on both buttons and toggle sidebarExpandEl.hidden in applySidebar()", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 两处 aria-expanded 同步写入 + 展开按钮可见性由 hidden 控制
		expect(PAGE_HTML).toContain('sidebarCollapseEl.setAttribute("aria-expanded"');
		expect(PAGE_HTML).toContain('sidebarExpandEl.setAttribute("aria-expanded"');
		expect(PAGE_HTML).toContain("sidebarExpandEl.hidden =");
	});

	it("should make the hidden attribute truly hide the expand button: a [hidden] CSS guard must beat the .icon-btn display override", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: .icon-btn 的 display: inline-flex（作者样式）会压过浏览器 UA 的
		// [hidden] { display: none }——若页面不自带守卫规则，sidebarExpandEl.hidden
		// 赋值与按钮上的 hidden 属性都形同虚设（侧栏已展开时展开按钮仍可见）。
		// 以下二选一即可（实现方采用其一）：
		//   ① 全局守卫：[hidden] { display: none !important; }
		//   ② 组合选择器：.icon-btn[hidden] { display: none; }
		// 宽容正则接受两种形式与空白差异；真实隐藏效果需浏览器验证。
		expect(PAGE_HTML).toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none(\s*!important)?\s*;/);
	});

	it("should bind a click listener on both the collapse and the expand button", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 两个按钮都有原生 click 绑定（Tab 聚焦 + Enter/Space 触发由原生
		// button 承担，键盘/点击交互需浏览器验证）
		expect(PAGE_HTML).toContain('sidebarCollapseEl.addEventListener("click"');
		expect(PAGE_HTML).toContain('sidebarExpandEl.addEventListener("click"');
	});
});

describe("PAGE_HTML 点击后立即高亮（字符串级契约）", () => {
	it("should define a highlightSelection function for the optimistic selection highlight", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 乐观更新函数名逐字存在（点击后不等树刷新立即高亮）
		expect(PAGE_HTML).toContain("highlightSelection");
	});

	it("should stamp the taskId on each tree row element as row.dataset.taskId or an equivalent data-task-id attribute", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 树行携带 taskId 标识，供 highlightSelection 按 id 定位行；
		// 契约允许 dataset.taskId（逐字锁 row.dataset.taskId）或等价的
		// setAttribute("data-task-id", ...) 两种写法
		expect(PAGE_HTML).toMatch(/row\.dataset\.taskId\s*=|row\.setAttribute\(\s*["']data-task-id["']/);
	});

	it("should call highlightSelection synchronously in route() right after state.taskId is assigned", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: route() 内 state.taskId 赋值后同步（400 字符窗口内、不等任何
		// 异步回调）调用 highlightSelection()，点击后立即高亮
		expect(PAGE_HTML).toMatch(/state\.taskId = routeTaskId\(\);[\s\S]{0,400}?highlightSelection\(\)/);
	});
});

describe("PAGE_HTML 移除新标签打开（字符串级契约）", () => {
	it("should keep 'new tab' and 'open-new' out of the page while allowing _blank only next to noopener (remote-image placeholder or body link)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 新标签语义文案与旧按钮 class 全字面 0 命中（不变）
		expect(PAGE_HTML).not.toContain("new tab");
		expect(PAGE_HTML).not.toContain("open-new");

		// Assert（第 7 轮 F 组契约 + 本轮 E 放宽）: _blank 只允许出现在两处 ——
		// 远程图片占位锚点构造处（F 组）与 renderMarkdown 正文来源链接的
		// target 赋值处（本轮 E：http(s) href 新标签打开，须与 noopener 同窗）。
		// 放行规则统一为「每处 _blank 的 ±300 字符窗口内必须带 noopener」；
		// 锚点存在性与三属性由 F 组/E 组用例锁定，此处只守「_blank 不外溢
		// 到无 noopener 保护的锚点」（正文链接同走这条放行规则）
		for (const match of PAGE_HTML.matchAll(/_blank/g)) {
			const index = match.index ?? 0;
			const window = PAGE_HTML.slice(Math.max(0, index - 300), index + 300);
			expect(window, "_blank without noopener in the ±300 window (only the remote-image placeholder and the renderMarkdown body link may carry it)").toContain("noopener");
		}
	});

	it("should keep _blank out of src/web/ except next to noopener (remote-image placeholder or renderMarkdown body link)", async () => {
		// Arrange: 动态 import node 内置模块，避免改动本文件既有 import 块
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const webDir = fileURLToPath(new URL("../src/web/", import.meta.url));

		// Act: 逐文件扫描 _blank；仅放行「±300 字符窗口内含 noopener」的出现
		// （第 7 轮 F 组占位锚点 target="_blank" + rel="noopener noreferrer"、
		// 本轮 E renderMarkdown 正文链接 target="_blank" 同窗 noopener ——
		// 两处同走这条放行规则），其余一律记为违规
		const offenders: string[] = [];
		for (const name of fs.readdirSync(webDir).filter((n: string) => n.endsWith(".ts"))) {
			const text = fs.readFileSync(path.join(webDir, name), "utf-8");
			for (const match of text.matchAll(/_blank/g)) {
				const index = match.index ?? 0;
				if (!text.slice(Math.max(0, index - 300), index + 300).includes("noopener")) {
					offenders.push(`${name}@${index}`);
				}
			}
		}

		// Assert: src/web/ 中每处 _blank 都属于占位锚点或正文链接（均与 noopener 同窗）
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 本轮新契约（第 3/4/5/6 项，字符串级锁定）：状态文字图例与行内状态词、
// rejected/failed 视觉区分与完整错误原文、卡头改名与卡内嵌套结构、system 块
// 不再渲染。SessionTreeNode 后端扩展 status 联合（+ rejected/failed）与可选
// reason/errorText 字段由后端 coder 同步实现；本组只锁页面渲染逻辑，不依赖后端。
// 解释性约定（node 环境无法行为级验证，取最强可判定形状）：
//   - renderMessage/renderEntry 的 system 处理取「显式跳过（return null/空）」
//     形状：纯移除分支会让 role 兜底渲染出可见 system 卡，不算满足契约；
//   - rejected/failed 节点点击的「不导航」取「errorText 判定 + 提前 return /
//     else 分流，之后才走到 activateRow / location.hash」的形状；
//   - 「可进入会话的入口」锁定为 href 指向 TASK_PREFIX + encodeURIComponent
//     (node.taskId) 的行内 open 链接（button 形状无法与既有行激活区分）。
// ---------------------------------------------------------------------------

/** 抽出 <style>…</style> 片段（供 CSS 规则断言）。 */
function pageStyle(): string {
	const start = PAGE_HTML.indexOf("<style>");
	const end = PAGE_HTML.indexOf("</style>");
	expect(start, "missing <style>").toBeGreaterThan(-1);
	expect(end, "missing </style>").toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end);
}

/** 抽出 PAGE_HTML 中 [from, to) 之间的 JS 片段（供渲染/激活逻辑断言）。 */
function jsRegion(from: string, to: string): string {
	const start = PAGE_HTML.indexOf(from);
	const end = PAGE_HTML.indexOf(to);
	expect(start, `missing marker: ${from}`).toBeGreaterThan(-1);
	expect(end, `missing marker: ${to}`).toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end);
}

// ---------------------------------------------------------------------------
// 第 4 项：状态文字可见（原「侧栏图例」已由本轮 C 契约退役）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 状态图例退役与行内状态词（字符串级契约）", () => {
	it("should drop the sidebar legend: no class=\"legend marker, no .legend CSS rule and no status-word legend text above #tree-list", () => {
		// Arrange: 侧栏片段（sidebar-head 起、#tree-list 之前）
		const start = PAGE_HTML.indexOf('class="sidebar-head"');
		const end = PAGE_HTML.indexOf('id="tree-list"');
		expect(start, "missing sidebar-head").toBeGreaterThan(-1);
		expect(end, "missing #tree-list").toBeGreaterThan(start);
		const sidebar = PAGE_HTML.slice(start, end);

		// Assert（本轮 C，当前应红）: 图例标记与 .legend/.legend-item 规则全部退役
		expect(PAGE_HTML, "legend markup must be removed").not.toContain('class="legend');
		expect(pageStyle(), "legend CSS rules must be removed").not.toMatch(/\.legend[\w-]*\s*\{/);

		// Assert: #tree-list 之前的侧栏片段不再含六个状态词的可见图例文本
		// （>…< 文本段；attr 值如 class="dot-running" 不算）
		for (const word of ["running", "recent", "finished", "pending", "rejected", "failed"]) {
			expect(sidebar, `sidebar must not show legend status word: ${word}`).not.toMatch(
				new RegExp(`>[^<>]*\\b${word}\\b[^<>]*<`)
			);
		}
	});

	it("should insert a visible status-word element carrying node.status on every tree row", () => {
		// Arrange: 行渲染函数 renderList 的函数体片段
		const fill = renderListBody();

		// Assert: 行内创建 .status-word 元素，且文本取自 node.status（不是只靠 dot 颜色）
		expect(fill).toContain('"status-word"');
		expect(fill).toMatch(/status-word[\s\S]{0,150}?node\.status|node\.status[\s\S]{0,150}?status-word/);
	});
});

// ---------------------------------------------------------------------------
// 第 3 项：rejected/failed 视觉区分 + 原因入行 title（.reason 本轮 A 退役）+ 完整错误原文面板
// ---------------------------------------------------------------------------

describe("PAGE_HTML rejected/failed 区分与错误原文（字符串级契约）", () => {
	it("should define distinct .dot-rejected/.dot-failed and .pill-rejected/.pill-failed rules that do not reuse the pending purple", () => {
		// Arrange: 四条独立状态规则的声明体
		const style = pageStyle();
		const rejectedDot = style.match(/\.dot-rejected\s*\{([^}]*)\}/)?.[1] ?? "";
		const failedDot = style.match(/\.dot-failed\s*\{([^}]*)\}/)?.[1] ?? "";
		const rejectedPill = style.match(/\.pill-rejected\s*\{([^}]*)\}/)?.[1] ?? "";
		const failedPill = style.match(/\.pill-failed\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: 规则存在且带颜色值；红色系 —— 不得引用 pending 紫
		expect(rejectedDot).toMatch(/#[0-9a-fA-F]{3,8}|var\(--[\w-]+\)/);
		expect(failedDot).toMatch(/#[0-9a-fA-F]{3,8}|var\(--[\w-]+\)/);
		expect(rejectedPill).toMatch(/color/);
		expect(failedPill).toMatch(/color/);
		for (const body of [rejectedDot, failedDot, rejectedPill, failedPill]) {
			expect(body).not.toContain("var(--pending)");
		}
	});

	it("should retire the inline .reason block: renderList creates no \"reason\" element, PAGE_HTML carries no class=\"reason\" and the .reason CSS rule is gone", () => {
		// Arrange: 行渲染函数片段（.reason 元素与 .reason 规则本轮 A 退役）
		const fill = renderListBody();

		// Assert（本轮 A 新契约，当前应红）: 行内不再创建 .reason 元素、不再
		// append node.reason —— rejected/failed 行与其他子 agent 行完全一致
		// （状态点 + 状态词 + agent 徽章 + taskId 短码 + 耗时 + 任务文本 + 聚合徽章）
		expect(fill, 'renderList must not create a "reason" element').not.toMatch(
			/el\(\s*"div"\s*,\s*"reason"/
		);
		expect(fill, "renderList must not append node.reason below the row").not.toMatch(
			/appendChild\([^)\n]*node\.reason/
		);

		// Assert: 页面标记不含 class="reason"（el() 走 className 赋值，退役后 0 命中）
		expect(PAGE_HTML, 'PAGE_HTML must not carry class="reason"').not.toContain('class="reason"');

		// Assert: .reason CSS 规则退役（拒绝原因改走行 title + .node-error 面板）
		expect(pageStyle(), ".reason CSS rule must be retired").not.toMatch(/\.reason\s*\{/);
	});

	it("should carry node.reason as the row title (one-line hover summary) instead of an inline block", () => {
		// Arrange: 行渲染函数片段
		const fill = renderListBody();

		// Act: 两种合法写法任一 —— row.title = node.reason 或
		// row.setAttribute("title", node.reason)
		const titleShapes = [
			/row\.title\s*=[^;\n]*node\.reason/,
			/setAttribute\(\s*"title"\s*,\s*[^)\n]*node\.reason\s*\)/,
		];

		// Assert（本轮 A 新契约，当前应红）: 拒绝原因不丢 —— 作为行的 title 摘要
		expect(
			titleShapes.some((shape) => shape.test(fill)),
			"the row title must carry node.reason as a one-line summary"
		).toBe(true);
	});

	it("should create the .node-error panel from JS with a matching CSS rule", () => {
		// Arrange: 样式块与 </style> 之后的脚本片段
		const style = pageStyle();
		const script = PAGE_HTML.slice(PAGE_HTML.indexOf("</style>"));

		// Assert: 面板 class 的 CSS 规则 + JS 侧创建引用
		expect(style).toMatch(/\.node-error\s*\{/);
		expect(script).toContain("node-error");
	});

	it("should render node.errorText through textContent (or the textContent-based el() helper), never innerHTML", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量；errorText 进入 DOM 的合法
		// 途径只有三种形状：el(..., node.errorText)（el 内部即 textContent）、
		// 直接 .textContent = …errorText、或先存变量再 .textContent 赋值（窗口匹配）
		const textContentFlow =
			/el\([^\n]*errorText[^\n]*\)/.test(PAGE_HTML) ||
			/\.textContent\s*=[^\n;]*errorText/.test(PAGE_HTML) ||
			/errorText[\s\S]{0,150}?\.textContent\s*=/.test(PAGE_HTML);

		// Assert: 至少一条 textContent 流入形状存在
		expect(textContentFlow).toBe(true);

		// Assert: errorText 绝不与 innerHTML 拼接（防注入）
		expect(PAGE_HTML).not.toMatch(/innerHTML\s*=[^\n]*errorText|errorText[^\n]*innerHTML/);

		// Assert: 完整原文 —— 不经过 oneLine/160 字截断或 .slice 截取
		expect(PAGE_HTML).not.toMatch(/errorText[\s\S]{0,150}?(?:oneLine\(|\.slice\()/);
	});

	it("should toggle the error panel on click instead of navigating when node.errorText exists", () => {
		// Arrange: 激活函数片段（含共享的点击/键盘激活路径）与点击处理区域片段
		const activate = jsRegion("function activateRow(", "function errorPanel(");
		const clickArea = jsRegion('row.addEventListener("click"', "function clearBanner(");

		// Act: 四种合法形状任一即通过（提前 return / else 分流 × 点击 handler /
		// activateRow 内），都要求 errorText 判定发生在导航动作之前
		const guardShapes = [
			/errorText[\s\S]{0,600}?\breturn\b[\s\S]{0,600}?activateRow\(/.test(clickArea),
			/errorText[\s\S]{0,600}?\}\s*else[\s\S]{0,400}?activateRow\(/.test(clickArea),
			/errorText[\s\S]{0,400}?\breturn\b[\s\S]{0,400}?location\.hash\s*=/.test(activate),
			/if\s*\([^)]*errorText[^)]*\)\s*\{[\s\S]{0,400}?\}\s*else\b[\s\S]{0,300}?location\.hash\s*=/.test(activate),
		];

		// Assert: 至少一条「先判 errorText、后导航」的形状存在
		expect(guardShapes.some(Boolean)).toBe(true);
	});

	it("should show both node.reason and the full node.errorText inside the existing .node-error panel", () => {
		// Arrange: errorPanel 函数体（缺失时 jsRegion 直接报红）
		const panel = jsRegion("function errorPanel(", "function renderList(");

		// Assert（本轮 A 新契约，当前应红）: 拒绝原因不丢 —— 既有 .node-error
		// 面板同时展示一句摘要 node.reason 与完整原文 node.errorText
		expect(panel, "the error panel must render node.reason").toContain("node.reason");
		expect(panel, "the error panel must keep rendering the full node.errorText").toContain("node.errorText");
	});

	it("should widen the error-panel creation and the click/keydown guards to errorText || reason (still: error -> toggle panel, never navigate)", () => {
		// Arrange: 行渲染函数体（errorEl 创建与 click/keydown 处理都在其中）
		const fill = renderListBody();

		// Act: 判定放宽形状 —— node.errorText || node.reason（或反序）
		const shape = /errorText\s*\|\|\s*[^)\n;]*reason|reason\s*\|\|\s*[^)\n;]*errorText/g;
		const hits = fill.match(shape) ?? [];

		// Assert（本轮 A 新契约，当前应红）: 三处判定同步放宽 —— errorEl 创建 +
		// click handler + keydown Enter/Space 分支，仍是「有错误 → 切面板、不导航」
		expect(
			hits.length,
			"errorEl creation and the click/keydown guards must all widen to errorText || reason"
		).toBeGreaterThanOrEqual(3);
	});

	it("should never call request() or /api/session on an errorText code path (rejected without taskId must not fetch)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 含 errorText 的行不得触发请求/会话拉取（回归守卫）
		expect(PAGE_HTML).not.toMatch(/errorText[^\n]*(?:request\(|\/api\/session)/);
		expect(PAGE_HTML).not.toMatch(/\/api\/session[^\n]*errorText/);
	});

	it("should provide a per-node open link (href to #/t/<taskId>) so a failed node's session stays reachable", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量；三种合法 href 写法任一
		const openShapes = [
			/\.href\s*=\s*TASK_PREFIX \+ encodeURIComponent\(node\.taskId\)/,
			/\.href\s*=\s*"#\/t\/" \+ encodeURIComponent\(node\.taskId\)/,
			/setAttribute\("href",\s*(?:TASK_PREFIX|"#\/t\/") \+ encodeURIComponent\(node\.taskId\)/,
		];

		// Assert: 存在指向该节点自身会话的行内 open 链接（与既有
		// childTaskId 导航锚点、activateRow 的 location.hash 区分开）
		expect(openShapes.some((shape) => shape.test(PAGE_HTML))).toBe(true);
	});

	it("should make the .node-error panel expandable/toggleable rather than permanently visible", () => {
		// Arrange: JS 中 node-error 首次出现处附近的代码窗口
		const script = PAGE_HTML.slice(PAGE_HTML.indexOf("</style>"));
		const panelWindow = script.match(/node-error[\s\S]{0,800}/)?.[0] ?? "";

		// Assert: 面板带展开/收起机制（hidden 切换 / classList.toggle /
		// toggle() helper / 原生 details 二选一）
		expect(panelWindow).toMatch(/\.hidden\s*=|classList\.toggle|toggle\(|el\("details"/);
	});
});

// ---------------------------------------------------------------------------
// 第 5 项：卡头改名（user→task、assistant→agent 名）+ tool result 中点 +
// 卡内嵌套缩进
// ---------------------------------------------------------------------------

describe("PAGE_HTML 卡头改名与卡内嵌套结构（字符串级契约）", () => {
	it("should label the user card header 'task' instead of 'user'", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: user 分支的 entry-header 文本为 "task"；"user" 卡头字面 0 命中
		expect(PAGE_HTML).toMatch(/entry-header",\s*"task"/);
		expect(PAGE_HTML).not.toMatch(/entry-header",\s*"user"/);
	});

	it("should label the assistant card header with the task's agent name, falling back to 'agent'", () => {
		// Arrange: renderMessage 的函数体片段
		const renderMsg = jsRegion("function renderMessage(", "function renderEntry(");

		// Assert: 卡头不再硬编码 "assistant"（role === "assistant" 判断本身保留无妨）
		expect(PAGE_HTML).not.toMatch(/entry-header",\s*"assistant"/);

		// Assert: 卡头取值逻辑引用 agent 名（node.agent 等），
		// 且回退字面为 "agent"
		expect(renderMsg).toMatch(/\.agent\b/);
		expect(renderMsg).toMatch(/"agent"/);
	});

	it("should render tool-result card headers as 'tool result · <tool>' with the U+00B7 middle dot", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 新中点分隔逐字存在；旧竖线分隔字面 0 命中
		expect(PAGE_HTML).toContain("tool result · ");
		expect(PAGE_HTML).not.toContain("tool result | ");
	});

	it("should indent nested thinking/tool blocks inside a card via an .entry .entry or .nested rule with margin-left and border-left", () => {
		// Arrange: 两种合法 CSS 形状 —— 通用嵌套选择器 .entry .entry（无需 JS），
		// 或专用 .nested 类（需 JS 侧真正应用该类）
		const style = pageStyle();
		const script = PAGE_HTML.slice(PAGE_HTML.indexOf("</style>"));

		const entryNested = style.match(/\.entry \.entry[^{}]*\{([^}]*)\}/)?.[1] ?? null;
		const classNested = style.match(/\.nested[^{}]*\{([^}]*)\}/)?.[1] ?? null;
		const jsAppliesNested = /\bnested\b/.test(script);

		// Assert: 形状存在（.nested 形状还要求 JS 引用）
		expect(entryNested !== null || (classNested !== null && jsAppliesNested)).toBe(true);

		// Assert: 规则体同时含左侧缩进与左边框
		const body = entryNested ?? classNested ?? "";
		expect(body).toMatch(/margin-left/);
		expect(body).toMatch(/border-left/);
	});
});

// ---------------------------------------------------------------------------
// 第 6 项：system 块不再渲染（服务端已剥离，页面须自保）
// ---------------------------------------------------------------------------

describe("PAGE_HTML 不再渲染 system 块（字符串级契约）", () => {
	it("should not render any visible system block: the details(\"system\" literal is gone", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: renderMessage 与 renderEntry 都不再产出 details("system", …)
		expect(PAGE_HTML).not.toContain('details("system"');
	});

	it("should skip role === \"system\" messages with an explicit empty return instead of rendering a card", () => {
		// Arrange: renderMessage 的函数体片段
		const renderMsg = jsRegion("function renderMessage(", "function renderEntry(");

		// Assert: 显式跳过形状 —— 分支 return null/空（纯移除会让 role 兜底
		// 渲染出可见 system 卡，不算满足契约）
		expect(renderMsg).toMatch(
			/role === "system"[^}]{0,150}?return\s*(?:null|undefined|""|el\("div"\)|document\.createDocumentFragment\(\))?\s*;/
		);

		// Assert: 该分支内不得产出任何可见元素
		expect(renderMsg).not.toMatch(/role === "system"[^}]{0,250}?(?:details\(|summaryEntry\(|entry-header)/);
	});

	it("should skip entry.type === \"system\" entries with an explicit empty return instead of rendering details", () => {
		// Arrange: renderEntry 的函数体片段
		const renderEntryBody = jsRegion("function renderEntry(", "function nearBottom(");

		// Assert: 显式跳过形状（允许分支内先算 body 再 return null）
		expect(renderEntryBody).toMatch(
			/entry\.type === "system"[^}]{0,200}?return\s*(?:null|undefined|"")?\s*;/
		);

		// Assert: 该分支内不得产出 details/summaryEntry 可见块
		expect(renderEntryBody).not.toMatch(/entry\.type === "system"[^}]{0,250}?(?:details\(|summaryEntry\()/);
	});
});

// ---------------------------------------------------------------------------
// 侧栏树与设计评审契约 / 设计令牌 / 焦点·选中·对比度 / 键盘语义 / 布局节奏
// （红阶段新增，字符串级契约；沿用本文件「宽容正则 + 断言各自存在」风格）
// 分组 A–E 对应设计评审必须改项清单 1–36：
//   A. 行点击激活（原「caret 折叠 1–9」整组退役：caret/折叠持久化/Collapse all/
//      Expand all/默认全展开等字面全部删除，扁平侧栏新语义见文末 A 组）
//   B. 设计令牌（10–15）：间距/字号/行高/圆角令牌、交互态与暗色覆盖、九个
//      状态令牌逐字、.dot-*/.pill-* 接令牌、--link、死 CSS .entry.system 清理
//   C. 焦点/选中/对比度（16–20）：全局 :focus-visible、splitter 改
//      :focus-visible、选中与焦点不叠圈、对比度修正逐字、splitter ::after 热区
//   D. 键盘/语义/Tab 序（21–26）：expand 按钮前置、收起后焦点转移、roving
//      tabindex 与方向键、role=list/listitem 语义、aria-hidden/alert/h2、
//      splitter aria-valuetext + Home/End
//   E. 布局节奏（27–36）：.node 节奏、任务文本单行省略、flex-shrink、
//      转录节奏、过渡与 reduced-motion、color-scheme、空态、顶栏标题、
//      窄窗比例、图例字号
// ---------------------------------------------------------------------------

describe("PAGE_HTML 侧栏树与设计评审契约（红阶段，字符串级）", () => {
	// ---- A. 行点击激活（原 caret 折叠组整体退役；扁平侧栏新语义见文末 A 组）----

	it("should route row clicks through activateRow (the caret collapse affordance is gone)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 行点击仍走 activateRow 激活路径（原「点 caret 与点行分离」的
		// caret 部分随 caret 退役，字面清单见文末 A 组）
		expect(PAGE_HTML).toMatch(/row\.addEventListener\("click"[\s\S]{0,400}?activateRow\(/);
	});

	// ---- B. 设计令牌（10–15）-----------------------------------------------

	it("should declare the spacing, font, line-height and radius token scales in :root", () => {
		// Arrange: 亮色 :root 规则片段
		const root = pageStyle().match(/:root\s*\{[^}]*\}/)?.[0] ?? "";

		// Assert: 间距档（至少 sp-1/sp-3/sp-4/sp-6）、字号档、行高、圆角档逐字
		expect(root).not.toBe("");
		expect(root).toMatch(/--sp-1:\s*4px/);
		expect(root).toMatch(/--sp-3:\s*12px/);
		expect(root).toMatch(/--sp-4:\s*16px/);
		expect(root).toMatch(/--sp-6:\s*32px/);
		expect(root).toMatch(/--fs-1:\s*11px/);
		expect(root).toMatch(/--fs-3:\s*13px/);
		expect(root).toMatch(/--fs-4:\s*15px/);
		expect(root).toMatch(/--lh-row:\s*20px/);
		expect(root).toMatch(/--r-1:\s*4px/);
		expect(root).toMatch(/--r-3:\s*8px/);
		expect(root).toMatch(/--r-full:\s*999px/);
	});

	it("should reference every scale token at least once outside :root (anti-dead-token)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 八个刻度令牌各自至少被 var(--token) 引用一次 —— 声明行
		// "--token:" 不含 var(，天然排除自身；var( 内空白宽容
		for (const token of ["--sp-3", "--sp-4", "--sp-5", "--sp-6", "--fs-3", "--fs-4", "--lh-row", "--r-3"]) {
			expect(PAGE_HTML, `dead token: ${token}`).toMatch(new RegExp(`var\\(\\s*${token}\\s*\\)`));
		}
	});

	it("should declare the hover/selected/active interaction tokens with their dark-scheme overrides", () => {
		// Arrange: 亮色 :root 规则片段
		const root = pageStyle().match(/:root\s*\{[^}]*\}/)?.[0] ?? "";

		// Assert: 亮色三态逐字
		expect(root).toMatch(/--hover-bg:\s*#eef1f5/);
		expect(root).toMatch(/--selected-bg:\s*#e7eefc/);
		expect(root).toMatch(/--active-bg:\s*#dde8fc/);

		// Assert: 暗色覆盖逐字（同名令牌在暗色 :root 中换值）
		expect(PAGE_HTML).toMatch(/--hover-bg:\s*#21262d/);
		expect(PAGE_HTML).toMatch(/--selected-bg:\s*#1c2b45/);
		expect(PAGE_HTML).toMatch(/--active-bg:\s*#223a5e/);
	});

	it("should declare the eight fixed light status tokens verbatim in :root (the recent dot is contrast-pinned instead)", () => {
		// Arrange: 亮色 :root 规则片段
		const root = pageStyle().match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
		// --st-recent-dot 不再锁字面值：light 圆点对比度 ≥3:1 由文末 B 组用例
		// 以 WCAG 公式计算锁定（原 #d9a032 对 #ffffff 仅 2.33，需重新配色）
		const tokens = [
			"--st-running-fg:\\s*#1a7f37",
			"--st-running-dot:\\s*#2e9e5b",
			"--st-recent-fg:\\s*#9a6700",
			"--st-finished-fg:\\s*#656d76",
			"--st-finished-dot:\\s*#8b949e",
			"--st-pending-fg:\\s*#6e56cf",
			"--st-rejected-fg:\\s*#cf222e",
			"--st-failed-fg:\\s*#82071e",
		];

		// Assert: 九个状态令牌逐字（亮色值）
		for (const token of tokens) {
			expect(root, `missing status token: ${token}`).toMatch(new RegExp(token));
		}
	});

	it("should wire the dot and pill status colours to the status tokens, including the dedicated pill-finished token", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: .dot-* 用 -dot 令牌（running/recent/finished 三条）
		expect(PAGE_HTML).toMatch(/\.dot-running\s*\{[^}]*var\(--st-running-dot\)/);
		expect(PAGE_HTML).toMatch(/\.dot-recent\s*\{[^}]*var\(--st-recent-dot\)/);
		expect(PAGE_HTML).toMatch(/\.dot-finished\s*\{[^}]*var\(--st-finished-dot\)/);

		// Assert: .pill-* 用 -fg 令牌（running/recent 两条）
		expect(PAGE_HTML).toMatch(/\.pill-running\s*\{[^}]*var\(--st-running-fg\)/);
		expect(PAGE_HTML).toMatch(/\.pill-recent\s*\{[^}]*var\(--st-recent-fg\)/);

		// Assert: .pill-finished 走专用令牌且亮色值逐字
		expect(PAGE_HTML).toMatch(/\.pill-finished\s*\{[^}]*var\(--pill-finished-fg\)/);
		expect(PAGE_HTML).toMatch(/--pill-finished-fg:\s*#57606a/);
	});

	it("should add the --link token and use it for body-content links", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 令牌逐字 + 正文链接规则（.text.markdown a / .subagent-link 之一）
		// 引用 var(--link)
		expect(PAGE_HTML).toMatch(/--link:\s*#0969da/);
		expect(PAGE_HTML).toMatch(/(?:\.text\.markdown\s+a|\.subagent-link)[^{]*\{[^}]*var\(--link\)/);
	});

	it("should drop the dead .entry.system CSS rule", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: system 块不再渲染（既有 JS 契约），对应死 CSS 同步清理
		expect(PAGE_HTML).not.toMatch(/\.entry\s*\.system/);
	});

	// ---- C. 焦点 / 选中 / 对比度（16–20）-----------------------------------

	it("should define a global :focus-visible rule with outline 2px solid var(--accent) and outline-offset: 2px", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 选择器必须是裸 :focus-visible / *:focus-visible（行首或
		// 空格/逗号/花括号之后），而非 .icon-btn:focus-visible 等局部规则
		expect(PAGE_HTML).toMatch(/(?:^|[\s{,])\*?:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent\)/m);
		expect(PAGE_HTML).toMatch(/(?:^|[\s{,])\*?:focus-visible\s*\{[^}]*outline-offset:\s*2px/m);
	});

	it("should move the splitter focus styling from :focus to :focus-visible", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 旧 .splitter:focus 规则 0 命中，新 .splitter:focus-visible 存在
		expect(PAGE_HTML).not.toMatch(/\.splitter:focus\s*\{/);
		expect(PAGE_HTML).toMatch(/\.splitter:focus-visible/);
	});

	it("should separate the selected-row fill from the focus ring and pad .tree-list by 6px", () => {
		// Arrange: 样式表片段
		const style = pageStyle();

		// Assert: 选中态背景 = --selected-bg，焦点 = 1px 内描边，不叠圈
		expect(style).toMatch(/\.node\.active[^{]*\{[^}]*background:\s*var\(--selected-bg\)/);
		expect(style).toMatch(/\.node:focus-visible[^{]*\{[^}]*box-shadow:\s*inset\s+0\s+0\s+0\s+1px\s+var\(--accent\)/);
		expect(style).toMatch(/\.tree-list\s*\{[^}]*padding:\s*6px/);
	});

	it("should apply the verbatim contrast fixes: pill tokens, dark new-content text, dark error banner and dark splitter", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: .pill-recent / .pill-running 引用修正后的 -fg 令牌
		expect(PAGE_HTML).toMatch(/\.pill-recent\s*\{[^}]*var\(--st-recent-fg\)/);
		expect(PAGE_HTML).toMatch(/\.pill-running\s*\{[^}]*var\(--st-running-fg\)/);

		// Assert: .pill-finished 走 #57606a 令牌
		expect(PAGE_HTML).toMatch(/\.pill-finished\s*\{[^}]*var\(--pill-finished-fg\)/);
		expect(PAGE_HTML).toMatch(/--pill-finished-fg:\s*#57606a/);

		// Assert: 暗色覆盖逐字 —— --st-finished-fg、暗色 .new-content 文字色
		expect(PAGE_HTML).toMatch(/--st-finished-fg:\s*#8b949e/);
		expect(PAGE_HTML).toMatch(/\.new-content[^{]*\{[^}]*color:\s*#0d1117/);

		// Assert: 暗色错误横幅底色（--error 令牌或 .banner 规则二选一）
		expect(PAGE_HTML).toMatch(/(?:--error:\s*#d1242f|\.banner[^{]*\{[^}]*#d1242f)/);

		// Assert: 暗色分隔条（*splitter* 令牌或 .splitter 规则二选一）
		expect(PAGE_HTML).toMatch(/(?:--[\w-]*splitter[\w-]*:\s*#6e7681|\.splitter[^{]*\{[^}]*#6e7681)/);
	});

	it("should widen the splitter hit area with a ::after layer inset 0 -4px", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: .splitter::after 层 + inset 宽容匹配（0 -4px / -4px 0、
		// 有无冒号后空格均可）
		expect(PAGE_HTML).toMatch(/\.splitter::?after[^{]*\{[^}]*inset:\s*(?:0\s+-4px|-4px\s+0)/);
	});

	// ---- D. 键盘 / 语义 / Tab 序（21–26）-----------------------------------

	it("should place the expand button in the DOM before #transcript (absolute positioning keeps the visual layout)", () => {
		// Arrange: 两个元素 id 字面的出现位置索引
		const transcriptIdx = PAGE_HTML.indexOf('id="transcript"');
		const expandIdx = PAGE_HTML.indexOf('id="sidebar-expand"');

		// Assert: 新规格 —— 展开按钮在 #transcript 之前
		expect(transcriptIdx).toBeGreaterThan(-1);
		expect(expandIdx).toBeGreaterThan(-1);
		expect(expandIdx).toBeLessThan(transcriptIdx);
	});

	it("should move focus to the expand button when the sidebar collapses", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: collapseSidebar() 函数体内出现 sidebarExpandEl.focus()
		// （收起侧栏后焦点不落在被隐藏的元素上）
		expect(PAGE_HTML).toMatch(/function collapseSidebar\(\)\s*\{[\s\S]{0,600}?sidebarExpandEl\.focus\(\)/);
	});

	it("should rove tabindex between tree rows with the literals \"0\" and \"-1\" and handle ArrowUp/ArrowDown/Home/End/Enter", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: roving tabindex —— 行 tabindex 被写为 "0" 与 "-1" 两种值
		const tabZero = /["']tabindex["']\s*,\s*["']0["']|\.tabindex\s*=\s*["']0["']/.test(PAGE_HTML);
		const tabMinus = /["']tabindex["']\s*,\s*["']-1["']|\.tabindex\s*=\s*["']-1["']/.test(PAGE_HTML);
		expect(tabZero).toBe(true);
		expect(tabMinus).toBe(true);

		// Assert: 键盘处理覆盖五个按键（在任一 keydown 监听窗口内）
		const keydowns = (PAGE_HTML.match(/addEventListener\("keydown"[\s\S]{0,900}/g) ?? []).join("\n");
		expect(keydowns).toContain("ArrowUp");
		expect(keydowns).toContain("ArrowDown");
		expect(keydowns).toContain("Home");
		expect(keydowns).toContain("End");
		expect(keydowns).toContain("Enter");
	});

	it("should hide status dots with aria-hidden, alert on banner errors, stay aria-live free, and title the sidebar with an <h2>", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 圆点对辅助技术隐藏（本轮 C 收紧）：legend 容器/静态标记二选一
		// 形状随图例退役删除，必须由 .dot 创建处满足 —— el("span", "dot…")
		// 创建的元素随后 setAttribute("aria-hidden", "true")
		const dotVars = [...PAGE_HTML.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=\s*el\(\s*"span"\s*,\s*"[^"]*\bdot\b[^"]*/g)]
			.map((m) => m[1]);
		expect(dotVars.length, 'missing .dot creation via el("span", "dot…")').toBeGreaterThan(0);
		const dotHidden = dotVars.some((v) =>
			new RegExp(`${v}\\.setAttribute\\(\\s*"aria-hidden"\\s*,\\s*"true"\\s*\\)`).test(PAGE_HTML)
		);
		expect(dotHidden, 'every .dot creation site must set aria-hidden="true"').toBe(true);

		// Assert: 错误横幅带 role="alert"
		const bannerTag = PAGE_HTML.match(/<div[^>]*id="banner"[^>]*>/)?.[0] ?? "";
		expect(bannerTag).toContain('role="alert"');

		// Assert: 不再使用 aria-live；侧栏标题由 span 改为 <h2>（class 保留）
		expect(PAGE_HTML).not.toContain("aria-live");
		expect(PAGE_HTML).toMatch(/<h2[^>]*sidebar-title/);
		expect(PAGE_HTML).not.toMatch(/<span[^>]*class="sidebar-title"/);
	});

	it("should extend the splitter with aria-valuetext and aria-controls=\"transcript\"", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 分隔条可读值文本 + 关联正文区
		expect(PAGE_HTML).toContain("aria-valuetext");
		expect(PAGE_HTML).toMatch(/aria-controls="transcript"|setAttribute\(\s*"aria-controls"\s*,\s*"transcript"\s*\)/);
	});

	it("should jump the splitter to SIDEBAR_MIN (200px) on Home and to the 60% max ratio on End", () => {
		// Arrange: 分隔条 keydown 监听窗口
		const splitterKey = PAGE_HTML.match(/splitter\w*\.addEventListener\("keydown"[\s\S]{0,800}/)?.[0] ?? "";

		// Assert: Home / End 两个分支 + SIDEBAR_MIN（200px）与比例常量引用
		expect(splitterKey).not.toBe("");
		expect(splitterKey).toContain("Home");
		expect(splitterKey).toContain("End");
		expect(splitterKey).toContain("SIDEBAR_MIN");
		expect(splitterKey).toMatch(/SIDEBAR_MAX_RATIO|0\.6|60\s*%/);
	});

	// ---- E. 布局节奏（27–36）-----------------------------------------------

	it("should keep .node on a single 32px line: flex-wrap: nowrap with the frozen height/padding/line-height/gap rhythm", () => {
		// Arrange: .node 基础规则片段
		const nodeRule = pageStyle().match(/\.node\s*\{[^}]*\}/)?.[0] ?? "";

		// Assert（本轮 C 新契约 + 审阅修复目标 2 收紧）: 单行 32px —— 永不折行
		// （flex-wrap: nowrap）+ 高度恰为 32px：必须是固定 height（字面 32px 或
		// 等价 --sp-6 令牌）+ box-sizing: border-box；min-height 在 6px 上下
		// padding 下会把行撑到 44px（32 + 12），不再是精确 32px，故不再放行；
		// padding/line-height/gap 按原节奏保留（6px 不在间距刻度内，保持字面值）；
		// .task-line 的省略号截断由相邻用例锁定
		expect(nodeRule).not.toBe("");
		expect(nodeRule).toMatch(/flex-wrap:\s*nowrap/);
		expect(nodeRule).toMatch(/(?<!min-)height:\s*(?:32px|var\(--sp-6\))/);
		expect(nodeRule).toMatch(/box-sizing:\s*border-box/);
		expect(nodeRule).toMatch(/line-height:\s*(?:20px|var\(--lh-row\))/);
		expect(nodeRule).toMatch(/padding:\s*6px\s+8px/);
		expect(nodeRule).toMatch(/gap:\s*6px/);
	});

	it("should ellipsize the task text in one line and stamp the full text as the element title", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 任务文本元素的单行省略样式（本轮 C：截断依赖 nowrap，两条同锁）
		expect(PAGE_HTML).toMatch(/\.task-line[^{]*\{[^}]*text-overflow:\s*ellipsis/);
		expect(PAGE_HTML).toMatch(/\.task-line[^{]*\{[^}]*white-space:\s*nowrap/);

		// Assert: JS 把全文写入 title 属性（三种合法写法任一）
		const titleShape =
			/\.title\s*=\s*node\.task/.test(PAGE_HTML) ||
			/setAttribute\(\s*["']title["']\s*,\s*node\.task\s*\)/.test(PAGE_HTML) ||
			/node\.task[\s\S]{0,80}?\.title\s*=/.test(PAGE_HTML);
		expect(titleShape).toBe(true);
	});

	it("should keep .tid and .elapsed from shrinking via flex-shrink: 0", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 两条规则（含组合选择器写法）各自带 flex-shrink: 0
		expect(PAGE_HTML).toMatch(/\.tid[^{}]*\{[^}]*flex-shrink:\s*0/);
		expect(PAGE_HTML).toMatch(/\.elapsed[^{}]*\{[^}]*flex-shrink:\s*0/);
	});

	it("should give .transcript a 16px/12px rhythm and .entry 12px padding with an 8px radius", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 转录区与条目卡的节奏值 —— 字面值或等价设计令牌二选一
		expect(PAGE_HTML).toMatch(/\.transcript[^{}]*\{[^}]*padding:\s*(?:16px|var\(--sp-4\))/);
		expect(PAGE_HTML).toMatch(/\.transcript[^{}]*\{[^}]*gap:\s*(?:12px|var\(--sp-3\))/);
		expect(PAGE_HTML).toMatch(/\.entry[^{}]*\{[^}]*padding:\s*(?:12px|var\(--sp-3\))/);
		expect(PAGE_HTML).toMatch(/\.entry[^{}]*\{[^}]*border-radius:\s*(?:8px|var\(--r-3\))/);
	});

	it("should declare a 120ms ease transition and a prefers-reduced-motion override with transition: none", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 过渡时长/缓动 + 无障碍减弱动效覆盖
		expect(PAGE_HTML).toMatch(/transition:[^;}]*120ms\s+ease/);
		expect(PAGE_HTML).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition:\s*none/);
	});

	it("should declare color-scheme: light dark on :root", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 原生亮/暗表单与控件配色声明
		expect(PAGE_HTML).toMatch(/:root[^{}]*\{[^}]*color-scheme:\s*light dark/);
	});

	it("should provide a centered .empty-state rule with 32px padding and muted text", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 空态样式三条（padding 允许字面值或等价令牌；居中取
		// text-align 或 flex 对齐其一）
		expect(PAGE_HTML).toMatch(/\.empty-state[^{}]*\{[^}]*padding:\s*(?:32px|var\(--sp-6\))/);
		expect(PAGE_HTML).toMatch(/\.empty-state[^{}]*\{[^}]*color:\s*var\(--muted\)/);
		expect(PAGE_HTML).toMatch(/\.empty-state[^{}]*\{[^}]*(?:text-align:\s*center|align-items:\s*center|justify-content:\s*center)/);
	});

	it("should size the topbar .title to 15px", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 顶栏标题字号 —— 字面 15px 或等价的 --fs-4（15px）令牌
		expect(PAGE_HTML).toMatch(/\.title[^{}]*\{[^}]*font-size:\s*(?:15px|var\(--fs-4\))/);
	});

	it("should use a 0.45 sidebar ratio behind the 1000px threshold for 700–1000px windows", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 0.45 比例（常量赋值或 innerWidth 直乘二选一）
		const ratio = /=\s*0\.45\b|innerWidth\s*\*\s*0\.45\b|0\.45\s*\*/.test(PAGE_HTML);
		expect(ratio).toBe(true);

		// Assert: 1000px 阈值 —— innerWidth 直比或含 MID/THRESH/WIDTH 等语义的
		// 常量声明；POLL_MS=1000、BACKOFF 的 1000 不满足语义名约束
		const threshold =
			/window\.innerWidth\s*(?:<|<=)\s*1000\b/.test(PAGE_HTML) ||
			/(?:var\s+)?[A-Za-z_]*(?:MID|RATIO|THRESH|WIDTH|UPPER|MAX|MIN)[A-Za-z_]*\s*=\s*1000\b/.test(PAGE_HTML);
		expect(threshold).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// tree-view 两函数 .toString() 内联同源守卫（现绿）：PAGE_HTML 用
// ${childSummary.toString()} / ${ancestorIds.toString()}
// 把 src/web/tree-view.ts 内联进页面（与 escapeRawHtml 同模式）。pruneCollapsed
// 随折叠功能整体退役（插值与用例一并删除）。删掉任一插值
// 其余字符串断言仍全绿，但页面首次渲染树即 ReferenceError —— 此处锁定插值本体。
// 写法参照 test/subagent-web-markdown.test.ts 的 escapeRawHtml/isSafeHref 守卫。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 内联 tree-view helper 源码（同源守卫）", () => {
	it("should inline childSummary and ancestorIds sources verbatim", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量；两 helper 与页面同模块图，
		// toString() 返回同一份转换后源码

		// Assert: 两段完整源码逐字存在于 PAGE_HTML（删除插值即红）
		expect(PAGE_HTML).toContain(childSummary.toString());
		expect(PAGE_HTML).toContain(ancestorIds.toString());
		expect(PAGE_HTML).toContain(crumbLabel.toString());
	});
});

// ---------------------------------------------------------------------------
// 信息架构 A：侧栏扁平化（红阶段，字符串级）。冻结契约：
//   A1. 函数 renderList(nodes)，renderTree() 内调用 renderList(state.tree)，
//       只渲染根节点（主会话直接派发的 depth 1）、不递归 children；fillTree 退役；
//   A2. #tree-list 带 role="list"；每个节点的包裹层 .node-group
//       role="listitem"（#tree-list 的直接子元素全为 listitem），
//       .node 行本身 role="button"（不再是 listitem）；role=tree/treeitem、
//       aria-level、aria-selected 字面全部退役；
//   A3. 选中行 class active + aria-current="true"；roving tabindex（focusRow、
//       updateRovingTabindex）保留；
//   A4. 行内容顺序：span.dot dot-<status> → span.status-word → span.badge →
//       span.tid → span.elapsed → div.task-line，行尾追加聚合徽章；
//   A5. 聚合徽章 = 行尾 el("span","child-summary", childSummary(node.children))，
//       返回值非空才 append、不再受 collapsed 门控；.child-summary 样式保留；
//   A6. caret 折叠整组字面退役（sidebar 面板折叠/宽度持久化/splitter 调宽保留）；
//   A7. 行 keydown 只保留 ArrowDown/ArrowUp/Home/End/Enter/Space。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

/** 抽 renderList( 声明之后到下一个具名函数之间的函数体（供递归/顺序断言）。 */
function renderListBody(): string {
	const start = PAGE_HTML.indexOf("function renderList(");
	expect(start, "missing renderList").toBeGreaterThan(-1);
	const bodyStart = start + "function renderList(".length;
	const nextNamed = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
	expect(nextNamed, "missing named function after renderList").not.toBeNull();
	return PAGE_HTML.slice(bodyStart, bodyStart + (nextNamed as RegExpExecArray).index);
}

describe("PAGE_HTML 侧栏扁平化（A，红阶段，字符串级）", () => {
	it("should render only the root rows via renderList(state.tree) and leave no fillTree or recursive child rendering behind", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 冻结命名 —— renderList(nodes) 定义 + renderTree() 内唯一调用点
		// renderList(state.tree)（扁平侧栏：孙任务不进侧栏）
		expect(PAGE_HTML).toContain("function renderList(");
		expect(PAGE_HTML).toMatch(/function renderTree\(\)[\s\S]{0,600}?renderList\(\s*state\.tree\s*\)/);

		// Assert: renderList( 全文只出现 2 次（1 次声明 + 1 次 renderTree 调用），
		// 无任何递归调用（无 children 实参），旧 fillTree 字面 0 命中
		const calls = PAGE_HTML.match(/renderList\(/g) ?? [];
		expect(calls).toHaveLength(2);
		expect(PAGE_HTML).not.toMatch(/renderList\([^)]*children/);
		expect(PAGE_HTML).not.toContain("fillTree");
	});

	it("should use list semantics: role=list on the container, role=listitem rows, and no tree/treeitem/aria-level/aria-selected anywhere", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: #tree-list 带 role="list"（静态属性或 boot 内 setAttribute 二选一）
		const treeListTag = PAGE_HTML.match(/<div[^>]*id="tree-list"[^>]*>/)?.[0] ?? "";
		const containerRole =
			/\brole="list"/.test(treeListTag) ||
			/setAttribute\(\s*"role"\s*,\s*"list"\s*\)/.test(PAGE_HTML);
		expect(containerRole).toBe(true);

		// Assert: listitem 存在（包裹层 .node-group 上，见下一条用例的精确定位）
		expect(PAGE_HTML).toMatch(/["']listitem["']/);

		// Assert: 旧树语义字面 0 命中
		expect(PAGE_HTML).not.toMatch(/role="tree"/);
		expect(PAGE_HTML).not.toMatch(/role="treeitem"/);
		expect(PAGE_HTML).not.toMatch(/setAttribute\(\s*"role"\s*,\s*"treeitem?"\s*\)/);
		expect(PAGE_HTML).not.toMatch(/aria-level/);
		expect(PAGE_HTML).not.toContain("aria-selected");
	});

	it("should put role=listitem on the .node-group wrapper and keep it off the .node row itself", () => {
		// Arrange: renderList 函数体（包裹层创建点与行创建块）
		const body = renderListBody();

		// Assert: 正向 —— .node-group 创建点附近的窗口内存在
		// setAttribute("role", "listitem")（包裹层即 list 的直接子项）
		const groupAt = body.indexOf('el("div", "node-group")');
		expect(groupAt, "missing .node-group wrapper creation").toBeGreaterThan(-1);
		expect(body.slice(groupAt, groupAt + 400)).toMatch(/setAttribute\(\s*"role"\s*,\s*"listitem"\s*\)/);

		// Assert: 行创建块（.node 行创建 → item.appendChild(row)）内不含
		// setAttribute("role", "listitem")（行可以带 role="button"，但不能是 listitem）
		const rowAt = body.indexOf('el("div", "node"');
		expect(rowAt, "missing .node row creation").toBeGreaterThan(-1);
		const rowEnd = body.indexOf("item.appendChild(row)", rowAt);
		expect(rowEnd, "missing item.appendChild(row)").toBeGreaterThan(rowAt);
		expect(body.slice(rowAt, rowEnd)).not.toMatch(/setAttribute\(\s*"role"\s*,\s*"listitem"\s*\)/);

		// Assert: renderList 体内 listitem 的 setAttribute 恰好 1 次，
		// 且就在包裹层创建点的窗口内（唯一 listitem 归属 .node-group）
		const listitemAttrs = body.match(/setAttribute\(\s*"role"\s*,\s*"listitem"\s*\)/g) ?? [];
		expect(listitemAttrs).toHaveLength(1);

		// Assert: 行创建块（.node 行创建 → item.appendChild(row)）内带
		// setAttribute("role", "button") —— 行是可激活按钮（不是 listitem），
		// 回归锁：删掉这一行则本断言红
		const rowBlock = body.slice(rowAt, rowEnd);
		expect(rowBlock).toMatch(/setAttribute\(\s*"role"\s*,\s*"button"\s*\)/);

		// Assert: renderList 体内 role="button" 的字面（role", "button）恰好 1 次 ——
		// 既不能漏（行不是按钮），也不能多（不得给其它元素重复贴按钮角色）
		const buttonAttrs = body.match(/role"\s*,\s*"button"/g) ?? [];
		expect(buttonAttrs).toHaveLength(1);

		// Assert: 键盘与点击共用同一激活路径 —— row keydown 监听的后续窗口内
		// 同时出现 activateRow(（Enter/Space 分支与 click 分支同一函数）与
		// preventDefault（同一分支内先阻止默认行为再激活）；窗口取 700 字符
		// （handler 内 Enter 分支的 activateRow 实测落在 625 字符处）
		const keydownAt = PAGE_HTML.indexOf('row.addEventListener("keydown"');
		expect(keydownAt, "missing row keydown handler").toBeGreaterThan(-1);
		const keyWindow = PAGE_HTML.slice(keydownAt, keydownAt + 700);
		expect(keyWindow, "row keydown window lacks preventDefault").toContain("preventDefault");
		expect(keyWindow, "row keydown window lacks activateRow(").toContain("activateRow(");
	});

	it("should mark the selected row with the active class and aria-current=true while keeping the roving tabindex helpers", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 选中行 = class active + aria-current="true"（aria-selected 退役，
		// 0 命中守卫在上一条用例锁定）
		const activeShape =
			/classList\.toggle\(\s*"active"/.test(PAGE_HTML) ||
			/classList\.add\(\s*"active"/.test(PAGE_HTML) ||
			/"node active"/.test(PAGE_HTML);
		expect(activeShape).toBe(true);
		const ariaCurrent =
			/setAttribute\(\s*"aria-current"\s*,\s*"true"\s*\)/.test(PAGE_HTML) ||
			/aria-current="true"/.test(PAGE_HTML);
		expect(ariaCurrent).toBe(true);

		// Assert: roving tabindex 两个助手保留
		expect(PAGE_HTML).toContain("function focusRow(");
		expect(PAGE_HTML).toContain("function updateRovingTabindex(");
	});

	it("should keep the frozen row content order dot, status-word, badge, tid, elapsed, task-line with the aggregate badge at the row tail", () => {
		// Arrange: 行渲染函数体（renderList 声明之后）
		const body = renderListBody();

		// Assert: 七段标记按出现先后排列 —— 同一函数体内先后即 appendChild 的
		// DOM 顺序，child-summary 必须排在 task-line 之后（行尾聚合徽章）
		const markers = ["dot dot-", "status-word", '"badge"', '"tid"', '"elapsed"', '"task-line"', "child-summary"];
		let cursor = -1;
		for (const marker of markers) {
			const index = body.indexOf(marker);
			expect(index, `row render is missing or out of order: ${marker}`).toBeGreaterThan(cursor);
			cursor = index;
		}
	});

	it("should append the childSummary(node.children) aggregate badge without any collapsed gating, keeping the .child-summary style", () => {
		// Arrange: renderList 函数体剔除注释 + 样式表片段
		const code = renderListBody().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
		const style = pageStyle();

		// Assert: 行尾聚合徽章调用逐字 —— childSummary(node.children)，且整段
		// 行渲染不再引用任何 collapsed 状态
		expect(code).toMatch(/childSummary\(\s*node\.children\s*\)/);
		expect(code).not.toMatch(/collapsed/);

		// Assert: .child-summary 样式保留（muted 小字）
		expect(style).toMatch(/\.child-summary\s*\{[^}]*color:\s*var\(--muted\)/);
		expect(style).toMatch(/\.child-summary\s*\{[^}]*(?:font-size:\s*var\(--fs-1\)|font-size:\s*11px)/);
	});

	it("should remove every caret/collapse literal from the page while the sidebar panel collapse stays intact", () => {
		// Arrange: PAGE_HTML 为固定导出常量。vendor marked 合法地含 `.caret`
		// （rules.other.caret），故禁字扫描前先剔除两段内联 vendor bundle，
		// 只查页面自有 CSS/JS 文本
		const pageOwn = PAGE_HTML.split(MARKED_JS).join("").split(HIGHLIGHT_JS).join("");

		// Assert: caret 折叠整组字面在页面自有文本中 0 命中（冻结清单）
		const forbidden = [
			".caret", "caret-empty", "collapse-all", "expand-all",
			"Collapse all", "Expand all", "asi-collapsed-tasks", "pruneCollapsed",
			"state.collapsed", "state.revealedFor", "ensureRevealed", "revealTask",
			"toggleCollapsed", "collapseAll", "expandAll", "collectCollapsible",
			"restoreCollapsed", "persistCollapsed", "containsTask", "collapseRow",
			"expandRow", "rowByNode", "fillTree", "aria-selected",
		];
		for (const literal of forbidden) {
			expect(pageOwn, `forbidden literal still present: ${literal}`).not.toContain(literal);
		}

		// Assert: 保留项不受误伤 —— 侧栏面板折叠/展开按钮、宽度持久化键、
		// splitter 左右键调宽、.node 行样式
		expect(PAGE_HTML).toContain("sidebar-collapse");
		expect(PAGE_HTML).toContain("sidebar-expand");
		expect(PAGE_HTML).toContain("asi-sidebar-collapsed");
		expect(PAGE_HTML).toContain("ArrowLeft");
		expect(PAGE_HTML).toContain("ArrowRight");
		expect(PAGE_HTML).toMatch(/\.node\s*\{/);
	});

	it("should not keep the write-only state.node field anywhere in the page", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert（清理锁）: state.node 曾是只写不读的死状态（updateStatusPill
		// 写入、无任何读取方），整体删除后不得复现 —— 全文 0 命中
		expect(PAGE_HTML).not.toMatch(/state\.node\b/);
	});

	it("should keep only ArrowDown/ArrowUp/Home/End/Enter/Space in the row keydown handler with no collapse arrow keys", () => {
		// Arrange: 行 keydown 监听窗口（起 900 字符；行 handler 之后隔着十余个
		// 函数才到 splitter/document 监听，窗口不会越界）
		const start = PAGE_HTML.indexOf('row.addEventListener("keydown"');
		expect(start, "missing row keydown handler").toBeGreaterThan(-1);
		const rowKey = PAGE_HTML.slice(start, start + 900);

		// Assert: 五个按键 + Space 全在
		for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
			expect(rowKey, `row keydown missing: ${key}`).toContain(key);
		}
		expect(rowKey).toMatch(/=== " "|=== "Spacebar"|=== "Space"/);

		// Assert: 行 keydown 不再处理折叠/展开方向键（splitter 的左右键调宽与
		// Alt+← 返回分别由其它用例锁定）
		expect(rowKey).not.toContain("ArrowLeft");
		expect(rowKey).not.toContain("ArrowRight");
	});
});

// ---------------------------------------------------------------------------
// 信息架构 B：深层页面面包屑 + 返回（红阶段，字符串级）。冻结契约：
//   B1. <section class="transcript-wrap"> 包裹 <nav id="crumbs" class="crumbs"
//       aria-label="Breadcrumb" hidden> 与 <section id="transcript">；CSS 新增
//       .transcript-wrap/.crumbs/.crumb/.crumb-sep/.back-btn；grid-column:3 与
//       面板收起时的 padding-top:44px 从 .transcript 移到 .transcript-wrap；
//   B2. renderCrumbs()：无 state.taskId → crumbsEl.hidden = true 并返回；否则
//       ← Back 按钮（click → goBack()，插入受祖先链非空守卫 —— 见文末 C 组）、
//       祖先段（state.path 优先、ancestorIds(state.tree, state.taskId) 回退，
//       每节 › 分隔 + 状态点，node 取自 findNode(state.tree, id)，缺失时中性
//       dot 不猜状态）+ 当前段（aria-current="page"）；"All tasks" 根链节已
//       退役（renderCrumbs 内无 <a class="crumb" href="#/">）；每节都是
//       <a class="crumb">、href 走 #/t/<encodeURIComponent(id)> 同页哈希；
//   B3. goBack()（本轮 A 改写 + 裁决 2 定稿）：祖先链为空（depth≤1）时提前
//       return、不写 location.hash（Alt+← 无动作）；非空时
//       location.hash = TASK_PREFIX + encodeURIComponent(直接上级 = 归一化链
//       末节)；"#/" 字面量允许作为守卫外兕底存在，但空链分支不得写 hash；
//       对应用例已按新契约改写。
//   B4. document 级 keydown：event.altKey && event.key === "ArrowLeft" →
//       preventDefault() + goBack()（不劫持浏览器后退）；
//   B5. route() 设置 state.taskId 后调用 renderCrumbs()（深链 #/t/<id> 经
//       hashchange 首屏即渲染）；renderTree() 末尾也调用（树到达后刷新完整链）。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

/** 抽指定具名函数到下一个具名函数之间的函数体（含声明行，供调用点/分支断言）。 */
function fnBody(name: string): string {
	const start = PAGE_HTML.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const bodyStart = start + `function ${name}(`.length;
	const nextNamed = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
	expect(nextNamed, `missing named function after ${name}`).not.toBeNull();
	return PAGE_HTML.slice(start, bodyStart + (nextNamed as RegExpExecArray).index);
}

/**
 * 抽 renderMarkdown 内 img[src] 处理段（从 img 查询到下一个 querySelectorAll
 * 之间），供占位锚点协议安全（契约 1）断言；缺 img 查询时报红而非静默空串。
 */
function markdownImageRegion(): string {
	const body = fnBody("renderMarkdown");
	const start = body.search(/querySelectorAll\(\s*["']img/);
	expect(start, "missing img[src] query in renderMarkdown").toBeGreaterThan(-1);
	const rest = body.slice(start);
	const next = rest.indexOf("querySelectorAll(", 1);
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * 抽 renderMarkdown 内 a[href] 处理段（从 a[href] 查询到下一个 querySelectorAll
 * 之间），供正文来源链接新标签打开（本轮 E）断言；缺查询时报红而非静默空串。
 */
function markdownAnchorRegion(): string {
	const body = fnBody("renderMarkdown");
	const start = body.search(/querySelectorAll\(\s*["']a\[href\]/);
	expect(start, "missing a[href] query in renderMarkdown").toBeGreaterThan(-1);
	const rest = body.slice(start);
	const next = rest.indexOf("querySelectorAll(", 1);
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * 从 body[from] 起找第一个条件匹配 condPattern 的 if 语句，返回其条件文本、
 * {…}（或单语句）块内容、可选 else 块与主块结束位置；找不到返回 null。
 * 括号/花括号配平扫描，不依赖书写格式；用于「插入/赋值必须位于守卫块内」
 * 的结构断言（本轮 C 的 Back 按钮守卫与 goBack 早退）。
 */
function findGuardedIf(
	body: string,
	from: number,
	condPattern: RegExp,
): { cond: string; block: string; elseBlock: string | null; blockEnd: number } | null {
	const re = /\bif\s*\(/g;
	re.lastIndex = from;
	let match: RegExpExecArray | null;
	while ((match = re.exec(body)) !== null) {
		const parenStart = match.index + match[0].length - 1;
		let depth = 0;
		let close = -1;
		for (let i = parenStart; i < body.length; i += 1) {
			if (body[i] === "(") depth += 1;
			else if (body[i] === ")") {
				depth -= 1;
				if (depth === 0) { close = i; break; }
			}
		}
		if (close === -1) return null;
		const cond = body.slice(parenStart + 1, close);
		if (!condPattern.test(cond)) continue;
		let start = close + 1;
		while (start < body.length && /\s/.test(body[start])) start += 1;
		if (body[start] !== "{") {
			const semi = body.indexOf(";", start);
			if (semi === -1) continue;
			return { cond, block: body.slice(start, semi + 1), elseBlock: null, blockEnd: semi + 1 };
		}
		let bdepth = 0;
		for (let i = start; i < body.length; i += 1) {
			if (body[i] === "{") bdepth += 1;
			else if (body[i] === "}") {
				bdepth -= 1;
				if (bdepth === 0) {
					const block = body.slice(start + 1, i);
					// 可选 else 块（if (chain === null) { … } else { 插入 … } 形状）
					const elseMatch = /^\s*else\s*\{/.exec(body.slice(i + 1));
					let elseBlock: string | null = null;
					if (elseMatch) {
						const elseStart = i + 1 + elseMatch[0].length - 1;
						let edepth = 0;
						for (let j = elseStart; j < body.length; j += 1) {
							if (body[j] === "{") edepth += 1;
							else if (body[j] === "}") {
								edepth -= 1;
								if (edepth === 0) { elseBlock = body.slice(elseStart + 1, j); break; }
							}
						}
					}
					return { cond, block, elseBlock, blockEnd: i };
				}
			}
		}
		return null;
	}
	return null;
}

describe("PAGE_HTML 深层页面面包屑与返回（B，红阶段，字符串级）", () => {
	it("should wrap the transcript in a section.transcript-wrap holding the hidden #crumbs nav and #transcript", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量
		const wrapIdx = PAGE_HTML.indexOf('<section class="transcript-wrap">');
		const crumbsIdx = PAGE_HTML.indexOf('<nav id="crumbs"');
		const transcriptIdx = PAGE_HTML.indexOf('<section id="transcript"');

		// Assert: 三个结构标记都存在且顺序为 wrap → crumbs → transcript
		expect(wrapIdx, 'missing <section class="transcript-wrap">').toBeGreaterThan(-1);
		expect(crumbsIdx, "missing #crumbs nav").toBeGreaterThan(wrapIdx);
		expect(transcriptIdx, "missing #transcript section").toBeGreaterThan(crumbsIdx);

		// Assert: nav 开标签属性逐字 —— class crumbs、aria-label Breadcrumb、初始 hidden
		const crumbsTag = PAGE_HTML.match(/<nav[^>]*id="crumbs"[^>]*>/)?.[0] ?? "";
		expect(crumbsTag).not.toBe("");
		expect(crumbsTag).toContain('class="crumbs"');
		expect(crumbsTag).toContain('aria-label="Breadcrumb"');
		expect(crumbsTag).toContain("hidden");
	});

	it("should declare the transcript-wrap, crumbs, crumb, crumb-sep and back-btn rules and move grid-column 3 plus the collapsed 44px offset onto transcript-wrap", () => {
		// Arrange: 样式表片段
		const style = pageStyle();

		// Assert: 五条新规则存在（.crumb 要求独立规则 —— .crumbs/.crumb-sep 不满足）
		expect(style).toMatch(/\.transcript-wrap\s*\{/);
		expect(style).toMatch(/\.crumbs\s*\{/);
		expect(style).toMatch(/\.crumb\s*\{/);
		expect(style).toMatch(/\.crumb-sep\s*\{/);
		expect(style).toMatch(/\.back-btn\s*\{/);

		// Assert: grid-column: 3 落在 .transcript-wrap；旧 .layout > .transcript
		// 的 grid-column 规则退役
		expect(style).toMatch(/\.transcript-wrap[^{}]*\{[^}]*grid-column:\s*3/);
		expect(style).not.toMatch(/\.layout\s*>\s*\.transcript\s*\{[^}]*grid-column/);

		// Assert: 面板收起时 padding-top: 44px 迁到 .transcript-wrap（旧
		// .layout.sidebar-collapsed .transcript 规则退役）
		expect(style).toMatch(/\.layout\.sidebar-collapsed[^{}]*\.transcript-wrap[^{}]*\{[^}]*padding-top:\s*44px/);
		expect(style).not.toMatch(/\.layout\.sidebar-collapsed[^{}]*\.transcript\s*\{[^}]*padding-top/);
	});

	it("should define renderCrumbs() with a #crumbs element reference that hides and returns when no task is selected", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: crumbsEl 元素引用逐字
		expect(PAGE_HTML).toContain('document.getElementById("crumbs")');

		// Assert: 无 state.taskId → hidden = true 且随后立即 return（先隐藏后返回
		// 的顺序锁定）或等价的 hidden = !state.taskId；有任务 → hidden = false 显示
		const hideShape =
			/crumbsEl\.hidden\s*=\s*true[\s\S]{0,80}?\breturn\b/.test(body) ||
			/crumbsEl\.hidden\s*=\s*!state\.taskId/.test(body);
		expect(hideShape).toBe(true);
		expect(body).toMatch(/crumbsEl\.hidden\s*=\s*false|crumbsEl\.hidden\s*=\s*!state\.taskId/);
		expect(body).toMatch(/state\.taskId/);
	});

	it("should render the verbatim Back button inside the crumbs and wire its click to goBack()", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 按钮整段逐字（id=back、class=back-btn、type=button、文本 ← Back）
		expect(PAGE_HTML).toContain('<button id="back" class="back-btn" type="button">← Back</button>');

		// Assert: click 监听 → goBack()（直接传引用或 handler 内调用二选一）
		expect(body).toMatch(/addEventListener\(\s*"click"\s*,[\s\S]{0,200}?(?:goBack\(\)|goBack\s*\))/);
	});

	it("should drop the 'All tasks' crumb copy from the page", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert（本轮 B 替代原「All tasks 根链节逐字」用例）: 链节文案字面
		// 0 命中 —— ">All tasks<" 是链节 <span…></span>All tasks</a> 的文本段，
		// 根链节退役后页面不得再有该文案
		expect(PAGE_HTML).not.toContain(">All tasks<");
	});

	it("should retire the All tasks root crumb anchor while keeping the .back-to-list href=\"#/\" entry", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: <a class="crumb" href="#/"> 根链节字面 0 命中
		expect(PAGE_HTML).not.toContain('<a class="crumb" href="#/">');

		// Assert: 未找到任务的返回入口 .back-to-list 同为 href="#/"，必须保留
		// （不得被根链节退役误伤）
		expect(PAGE_HTML).toContain('<a class="back-to-list" href="#/">');
	});

	it("should stop renderCrumbs() from inserting the All tasks root crumb", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 函数体内不再有插入 <a class="crumb" href="#/"> 的
		// insertAdjacentHTML（无论书写格式/引号变体）
		expect(body).not.toMatch(/insertAdjacentHTML\([\s\S]{0,120}?<a class="crumb" href="#\/"/);
	});

	it("should keep the neutral dot-root status dot as the ancestor/current crumb fallback", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量 + renderCrumbs 函数体

		// Assert: .dot-root CSS 规则存在，背景取 var(--muted)（中性灰点）——
		// 根链节退役后 dot-root 仍是祖先段/当前段状态点的中性兜底
		expect(PAGE_HTML).toMatch(/\.dot-root\s*\{[^}]*background:\s*var\(--muted\)/);
		const body = fnBody("renderCrumbs");
		expect(body).toMatch(/:\s*" dot-root"/);
	});

	it("should render the breadcrumb as ancestor segments plus the current segment with aria-current=page", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 祖先段（› 分隔符 + 链节构造）与当前段（aria-current="page"）
		// 结构仍在 —— 根链节退役后只剩这两段
		expect(body).toMatch(/["']crumb-sep["']/);
		const current =
			/setAttribute\(\s*"aria-current"\s*,\s*"page"\s*\)/.test(body) ||
			/aria-current="page"/.test(body);
		expect(current, "the current segment must keep aria-current=page").toBe(true);

		// Assert: 结构中不再有 #/ 根段（根链节唯一来源）
		expect(body, "renderCrumbs must not render a #/ root segment").not.toContain('href="#/"');
	});

	it("should build the ancestor crumb chain from ancestorIds(state.tree, state.taskId) with crumb-sep separators and encoded hash hrefs", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 三层链的祖先数组逐字来自 ancestorIds(state.tree, state.taskId)
		expect(body).toMatch(/ancestorIds\(\s*state\.tree\s*,\s*state\.taskId\s*\)/);

		// Assert: 每个祖先一节 —— crumb-sep 分隔符 + › 字符 + 链节为 <a class="crumb">
		// （el("a","crumb") 或静态 <a class="crumb" 二选一），href 走
		// TASK_PREFIX + encodeURIComponent(<id>)
		expect(body).toMatch(/["']crumb-sep["']/);
		expect(body).toContain("›");
		const crumbAnchor = /el\(\s*"a"\s*,\s*"crumb"\s*\)|<a class="crumb"/.test(body);
		expect(crumbAnchor).toBe(true);
		expect(body).toMatch(/(?:TASK_PREFIX|"#\/t\/")\s*\+\s*encodeURIComponent\(/);
	});

	it("should put a status dot on each crumb from findNode(state.tree, ...) with a neutral fallback that never guesses a status", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 节点取自 findNode(state.tree, <id>) —— 状态只能来自树数据
		expect(body).toMatch(/findNode\(\s*state\.tree\s*,/);

		// Assert: 中性 "dot" 基类 + 条件 " dot-" 状态后缀拼接；且链节渲染里不得
		// 硬编码任何 dot-<status> 字面（硬编码 = 猜状态）
		expect(body).toMatch(/["']dot["']/);
		expect(body).toMatch(/dot-/);
		// Assert（变异锁）: 中性兕底必须是显式 " dot-root" 后缀 —— 祖先链与
		// 当前节两处三元分支的 else 臂改成空串/裸 dot 会在此变红
		expect(body).toMatch(/:\s*" dot-root"/);
		expect(body).not.toMatch(/dot-(?:running|recent|finished|pending|rejected|failed)/);
	});

	it("should render the current task crumb with its encoded hash href and aria-current=page", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 当前链节 href = TASK_PREFIX + encodeURIComponent(state.taskId)
		expect(body).toMatch(/(?:TASK_PREFIX|"#\/t\/")\s*\+\s*encodeURIComponent\(\s*state\.taskId\s*\)/);

		// Assert: aria-current="page" 标注当前节（setAttribute 或静态属性二选一）
		const current =
			/setAttribute\(\s*"aria-current"\s*,\s*"page"\s*\)/.test(body) ||
			/aria-current="page"/.test(body);
		expect(current).toBe(true);
	});

	it("should navigate goBack() to the direct parent = the last segment of the server path", () => {
		// Arrange: goBack 函数体
		const body = fnBody("goBack");

		// Assert（本轮 A 改写）: 直接上级取自服务端 path 的最后一节 —— state.path
		// 在函数体内被读取，末位取法宽容（[x.length - 1] / .slice(-1) / .at(-1) 任一），
		// 仍以 location.hash 走同页哈希（TASK_PREFIX + encodeURIComponent(...)）
		expect(body).toMatch(/\bstate\.path\b/);
		expect(body).toMatch(/location\.hash\s*=/);
		expect(body).toMatch(/(?:TASK_PREFIX|"#\/t\/")\s*\+\s*encodeURIComponent\(/);
		expect(body).toMatch(/\[[A-Za-z_$][\w$]*\.length\s*-\s*1\]|\.slice\(\s*-1\s*\)|\.at\(\s*-1\s*\)/);
	});

	it("should make goBack() leave location.hash untouched when the ancestor chain is empty (top-level task)", () => {
		// Arrange: goBack 函数体
		const body = fnBody("goBack");
		const hashIdx = body.search(/location\.hash\s*=/);
		expect(hashIdx, "goBack must still navigate via location.hash").toBeGreaterThan(-1);

		// Act: 祖先链空判定守卫（backTarget(...) 条件内联、!back、
		// .length === 0 等形状任一）
		const guard = findGuardedIf(body, 0, /null|!\s*[A-Za-z_$][\w$]*|\.length\s*(?:===?\s*0|<\s*1|<=\s*0)/);
		expect(guard, "goBack must detect the empty ancestor chain (depth ≤1)").not.toBeNull();
		const hit = guard as NonNullable<typeof guard>;

		// Assert（裁决 2 新契约）: 空链分支紧跟提前 return —— 深度 ≤1 时
		// Alt+← 无动作；location.hash 赋值只发生在该守卫之后，空链不写 hash。
		// 不要求（也不禁止）"#/" 字面量 —— 允许它作为守卫之外的兜底存在，
		// 本用例只锁「空链不改变 hash」这一行为契约
		expect(hit.block, "the empty-chain branch must early-return without navigating").toMatch(/\breturn\b/);
		expect(
			hashIdx,
			"location.hash must only be written after the empty-chain guard"
		).toBeGreaterThan(hit.blockEnd);
	});

	it("should trigger goBack() on Alt+ArrowLeft via a document-level keydown listener with preventDefault", () => {
		// Arrange: document 级 keydown 监听窗口
		const docKey = PAGE_HTML.match(/document\.addEventListener\(\s*"keydown"[\s\S]{0,700}/)?.[0] ?? "";

		// Assert: 监听器存在 + altKey 与 "ArrowLeft" 逐字 + preventDefault()
		// （不劫持浏览器后退之外的默认行为）+ goBack()
		expect(docKey, "missing document-level keydown listener").not.toBe("");
		expect(docKey).toContain("altKey");
		expect(docKey).toContain('"ArrowLeft"');
		expect(docKey).toContain("preventDefault()");
		expect(docKey).toMatch(/goBack\(\)/);
	});

	it("should call renderCrumbs() from route() right after state.taskId is set, keeping deep links and hash navigation consistent", () => {
		// Arrange: route 函数体
		const body = fnBody("route");

		// Assert: route() 设置 state.taskId 后调用 renderCrumbs() —— 深链
		// #/t/<id> 与浏览器前进/后退经 hashchange→route 都会刷新面包屑
		expect(body).toMatch(/state\.taskId\s*=\s*routeTaskId\(\);[\s\S]{0,400}?renderCrumbs\(\)/);
		expect(PAGE_HTML).toContain('window.addEventListener("hashchange", route)');
	});

	it("should call renderCrumbs() at the end of renderTree() so the crumb chain refreshes once the tree arrives", () => {
		// Arrange: renderTree 函数体
		const body = fnBody("renderTree");

		// Assert: renderList 之后（函数末尾）调用 renderCrumbs() 刷新完整祖先链
		expect(body).toMatch(/renderList\(\s*state\.tree\s*\)/);
		const crumbsIdx = body.indexOf("renderCrumbs()");
		expect(crumbsIdx, "renderTree must call renderCrumbs()").toBeGreaterThan(-1);
		expect(crumbsIdx).toBeGreaterThan(body.indexOf("renderList("));
	});
});

// ---------------------------------------------------------------------------
// 第 7 轮（cycle-2）契约 C：/api/tree 消费对象形状 {apiVersion,nodes,truncated,
// expand} + 截断提示（红阶段，字符串级）。冻结契约：
//   C1. refreshTree() 内 state.tree = Array.isArray(data.nodes) ? data.nodes : []
//       （响应体不再是裸数组）；state.truncated = data.truncated；
//   C2. 新元素 #truncated-note（class truncated-note，含 CSS 规则）；
//   C3. truncated.dropped > 0 时显示，精确文案 "显示最新 " + showing +
//       " / 共 " + total；未截断隐藏（hidden 切换判据锁 dropped > 0 同窗）。
// 实现由 coder 落地；本组在 src/web/page.ts 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML /api/tree 新版消费与截断提示（C，红阶段，字符串级）", () => {
	it("should read the tree nodes from the response object's .nodes field in refreshTree instead of the bare array body", () => {
		// Arrange: refreshTree 函数体
		const body = fnBody("refreshTree");

		// Assert: state.tree 取自同一响应变量的 .nodes（对象形状），非数组回落空 ——
		// 变量名宽容（data/payload/...），但 .nodes 必须出现两次且同源
		expect(body).toMatch(/state\.tree\s*=\s*Array\.isArray\(\s*(\w+(?:\.\w+)*)\.nodes\s*\)\s*\?\s*\1\.nodes\s*:\s*\[\]/);

		// Assert: 旧形状（把响应体本身当数组存进 state.tree）字面 0 命中
		expect(body).not.toMatch(/state\.tree\s*=\s*Array\.isArray\(\s*\w+\s*\)\s*\?\s*\w+\s*:\s*\[\]/);
	});

	it("should store the truncation info from the /api/tree response into state.truncated", () => {
		// Arrange: refreshTree 函数体 + state 状态对象片段
		const body = fnBody("refreshTree");

		// Assert: 写入逐字 —— state.truncated = <响应>.truncated
		expect(body).toMatch(/state\.truncated\s*=\s*\w+(?:\.\w+)*\.truncated/);

		// Assert: state 对象声明 truncated 字段（读取方见下一条用例）
		expect(PAGE_HTML).toMatch(/state\s*=\s*\{[\s\S]{0,900}?\btruncated\b/);
	});

	it("should render the verbatim #truncated-note element with the .truncated-note class and a matching CSS rule", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量
		const tag = PAGE_HTML.match(/<\w+[^>]*id="truncated-note"[^>]*>/)?.[0] ?? "";

		// Assert: 元素 id、class 与 CSS 规则逐字 + JS 侧元素引用
		expect(tag, "missing #truncated-note element").not.toBe("");
		expect(tag).toContain('class="truncated-note"');
		expect(pageStyle()).toMatch(/\.truncated-note\s*\{/);
		expect(PAGE_HTML).toContain('document.getElementById("truncated-note")');
	});

	it("should show the truncation note only when truncated.dropped > 0 with the exact copy '显示最新 <showing> / 共 <total>'", () => {
		// Assert: 文案拼接逐字 —— "显示最新 " + <showing> + " / 共 " + <total>
		expect(PAGE_HTML).toMatch(/"显示最新 "\s*\+\s*[\w.]*showing\s*\+\s*" \/ 共 "\s*\+\s*[\w.]*total/);

		// Assert: 显隐判据 —— 捕获 #truncated-note 引用变量，其 .hidden 赋值
		// 窗口（±350 字符）内必须出现 dropped > 0（未截断即隐藏）
		const ref = PAGE_HTML.match(/(?:var|let|const)\s+(\w+)\s*=\s*document\.getElementById\(\s*"truncated-note"\s*\)/);
		expect(ref, "missing #truncated-note element reference").not.toBeNull();
		const name = (ref as RegExpExecArray)[1];
		const hiddenIdx = PAGE_HTML.search(new RegExp(`${name}\\.hidden\\s*=`));
		expect(hiddenIdx, `${name}.hidden assignment missing`).toBeGreaterThan(-1);
		const window = PAGE_HTML.slice(Math.max(0, hiddenIdx - 350), hiddenIdx + 355);
		expect(window, "hidden toggle must be gated on truncated.dropped > 0").toMatch(/dropped\s*>\s*0/);
	});
});

// ---------------------------------------------------------------------------
// 用户口径修订（第 8 轮）契约 D1/D2：侧栏日志式顺序 + 树轮询 2–3 秒。
//   D1.（改写）日志式顺序，最旧在上、最新在下 —— 逐字常量
//       var LIST_NEWEST_FIRST = false;（注释「用户口径：日志式，最新在底部」）；
//       renderList 内
//       var list = LIST_NEWEST_FIRST ? nodes.slice().reverse() : nodes;
//       默认（false）按传入顺序（服务端每层 startedAt 升序）渲染、不反转；
//       旧「必须倒序（最新在上）」断言按用户口径删除；
//       expand 子层发现顺序不变（本组不测顺序，勿新增约束）。
//   D2. var TREE_EVERY = 3;（既有用例由 15 改锁 3，文件头部另有 POLL_MS 不变
//       的成对锁定）。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 侧栏日志式顺序（D1 改写，红阶段，字符串级）", () => {
	it("should declare the verbatim constant var LIST_NEWEST_FIRST = false; carrying the 日志式 user note", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 逐字常量 false（日志式 = 最新在底部）+ 注释口径逐字
		expect(PAGE_HTML).toContain("var LIST_NEWEST_FIRST = false;");
		expect(PAGE_HTML).toContain("用户口径：日志式，最新在底部");
	});

	it("should gate the reverse behind LIST_NEWEST_FIRST so renderList defaults to the passed oldest-first order", () => {
		// Arrange: 行渲染函数体
		const body = renderListBody();

		// Assert: 逐字三元行 —— 默认分支 nodes（传入顺序 = 最旧在上），
		// 反转只在 LIST_NEWEST_FIRST 为真时发生
		expect(body).toContain("var list = LIST_NEWEST_FIRST ? nodes.slice().reverse() : nodes;");

		// Assert: renderList 引用该常量，且 nodes.slice().reverse() 全函数体
		// 只出现于该三元行（无条件倒序渲染已删除）
		expect(body).toContain("LIST_NEWEST_FIRST");
		const reverseLines = body.split("\n").filter((line) => line.includes("nodes.slice().reverse()"));
		expect(reverseLines).toHaveLength(1);
		expect(reverseLines[0]).toContain("LIST_NEWEST_FIRST ? nodes.slice().reverse() : nodes");
	});
});

// ---------------------------------------------------------------------------
// 第 7 轮（cycle-2）契约 E1：apiVersion 自检横幅（红阶段，字符串级）。
//   E1a. 页面 import { API_VERSION } from "./api-version.ts" 并以字面量内联
//        var PAGE_API_VERSION = 2;；
//   E1b. /api/tree（refreshTree）与 /api/session（pollOnce）响应 apiVersion
//        与 PAGE_API_VERSION 不一致 → 顶部 banner 精确文案
//        "页面代码与后端不匹配，请刷新（⌘⇧R）"。
// ---------------------------------------------------------------------------

describe("PAGE_HTML apiVersion 自检横幅（E1，红阶段，字符串级）", () => {
	it("should import API_VERSION from src/web/api-version.ts and inline it as the literal var PAGE_API_VERSION = 2;", async () => {
		// Arrange: 动态 import node 内置模块与 api-version 常量模块
		const fs = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const pageSrc = fs.readFileSync(fileURLToPath(new URL("../src/web/page.ts", import.meta.url)), "utf-8");
		const { API_VERSION } = await import("../src/web/api-version.ts");

		// Assert: 页面源码从 api-version.ts 导入 API_VERSION（单一来源）
		expect(pageSrc).toMatch(/import\s*\{[^}]*API_VERSION[^}]*\}\s*from\s*"\.\/api-version\.ts"/);

		// Assert: PAGE_HTML 内联字面量与模块常量同值（防漂移），并逐字锁 = 2
		expect(PAGE_HTML).toContain(`var PAGE_API_VERSION = ${API_VERSION};`);
		expect(PAGE_HTML).toContain("var PAGE_API_VERSION = 2;");
	});

	it("should show the verbatim mismatch banner copy '页面代码与后端不匹配，请刷新（⌘⇧R）' from the page script", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量
		const copy = "页面代码与后端不匹配，请刷新（⌘⇧R）";
		const copyIdx = PAGE_HTML.indexOf(copy);

		// Assert: 文案逐字存在且位于脚本区（运行时写入 #banner）
		expect(copyIdx, "missing mismatch banner copy").toBeGreaterThan(-1);
		expect(copyIdx).toBeGreaterThan(PAGE_HTML.indexOf("</style>"));

		// Assert: 文案与 apiVersion 比较或 banner 元素同窗（±400 字符）——
		// mismatch 分支把该文案写进顶部横幅
		const window = PAGE_HTML.slice(Math.max(0, copyIdx - 400), copyIdx + 400);
		expect(window).toMatch(/apiVersion|bannerEl/);
	});

	it("should compare the apiVersion of both /api/tree and /api/session responses against PAGE_API_VERSION", () => {
		// Arrange: 不匹配判据形状（任一书写方向与不等算符）
		const mismatchGuard = (body: string): boolean =>
			/apiVersion\s*(?:!==|!=)\s*PAGE_API_VERSION/.test(body) ||
			/PAGE_API_VERSION\s*(?:!==|!=)\s*(?:\w+\.)?apiVersion/.test(body);

		// Assert: /api/tree（refreshTree）与 /api/session（pollOnce）两处都比较
		expect(mismatchGuard(fnBody("refreshTree")), "refreshTree must guard response apiVersion").toBe(true);
		expect(mismatchGuard(fnBody("pollOnce")), "pollOnce must guard response apiVersion").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 第 7 轮（cycle-2）契约 E2 + 本轮 A 修订：#last-update 只在失败态显示
// （红阶段，字符串级）。
//   E2a. 顶栏内 #last-update（class last-update，含 CSS 规则）—— 元素与
//        .last-update / .last-update.error CSS 保留（不变）；
//   A. 健康态（无失败）文本置空：updateLastUpdate 成功分支写空串、class
//        恢复 "last-update"（不含 error）；PAGE_HTML 不再含 "最后更新 "
//        字面与 >等待数据< 文案（原「成功文案逐字」用例已按本轮 A 契约改写）；
//   E2c. 取数失败变红：.last-update.error CSS 规则 + JS 打 error 类（不变）；
//   E2d. 失败时写明原因（HTTP 状态码 / 网络错误文案，不变）。
// ---------------------------------------------------------------------------

/** 捕获 #last-update 元素引用变量名（getElementById / querySelector 二选一）。 */
function lastUpdateVar(): string {
	const ref =
		PAGE_HTML.match(/(?:var|let|const)\s+(\w+)\s*=\s*document\.getElementById\(\s*"last-update"\s*\)/) ??
		PAGE_HTML.match(/(?:var|let|const)\s+(\w+)\s*=\s*document\.querySelector\(\s*"#last-update"\s*\)/);
	expect(ref, "missing #last-update element reference").not.toBeNull();
	return (ref as RegExpExecArray)[1];
}

describe("PAGE_HTML 最后更新指示器（E2，红阶段，字符串级）", () => {
	it("should render #last-update with class .last-update inside the topbar and a matching CSS rule", () => {
		// Arrange: 顶栏片段与元素开标签
		const topbar = PAGE_HTML.match(/<header[^>]*class="topbar"[\s\S]*?<\/header>/)?.[0] ?? "";
		expect(topbar, "missing topbar").not.toBe("");
		const tag = topbar.match(/<\w+[^>]*id="last-update"[^>]*>/)?.[0] ?? "";

		// Assert: 元素位于右上角顶栏内，id/class 逐字，CSS 规则存在
		expect(tag, "missing #last-update inside the topbar").not.toBe("");
		expect(tag).toContain('class="last-update"');
		expect(pageStyle()).toMatch(/\.last-update\s*\{/);
	});

	it("should clear the indicator in the healthy state: the success branch writes an empty string and the plain .last-update class", () => {
		// Arrange: updateLastUpdate 函数体 + 元素引用变量
		const body = fnBody("updateLastUpdate");
		const name = lastUpdateVar();

		// Assert（本轮 A，当前应红）: 无失败时 class 恢复无 error 的基础值
		const plain = new RegExp(`${name}\\.className\\s*=\\s*"last-update"`).test(body);
		expect(plain, "healthy branch must restore the plain .last-update class").toBe(true);

		// Assert（本轮 A，当前应红）: 成功分支把 #last-update 文本置空
		// （不再常显「最后更新 Ns 前」/「等待数据」）
		const cleared = new RegExp(`${name}\\.textContent\\s*=\\s*""`).test(body);
		expect(cleared, "healthy branch must write an empty string into #last-update").toBe(true);
	});

	it("should drop the always-on copy: PAGE_HTML carries neither the \"最后更新 \" literal nor the >等待数据< marker", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert（本轮 A，当前应红）: 成功文案与等待文案字面 0 命中
		expect(PAGE_HTML).not.toContain('"最后更新 "');
		expect(PAGE_HTML).not.toContain(">等待数据<");
	});

	it("should paint the indicator red on fetch failure via the .last-update.error CSS rule and an error class in JS", () => {
		// Arrange: 样式表片段与元素引用变量
		const style = pageStyle();
		const name = lastUpdateVar();

		// Assert: 失败态 CSS 规则 + 红色取值（--error 令牌或红 hex）
		expect(style).toMatch(/\.last-update\.error[^{]*\{[^}]*(?:var\(--error\)|#[0-9a-fA-F]{3,8}|red)/);

		// Assert: JS 侧给元素打 error 类（className 赋值 / classList.add / toggle
		// 三种写法任一）
		const classShapes = [
			new RegExp(`${name}\\.className\\s*=\\s*"[^"]*\\berror\\b`),
			new RegExp(`${name}\\.classList\\.add\\(\\s*"error"\\s*\\)`),
			new RegExp(`${name}\\.classList\\.toggle\\(\\s*"error"\\s*,\\s*true\\s*\\)`),
		];
		expect(classShapes.some((shape) => shape.test(PAGE_HTML))).toBe(true);
	});

	it("should write the failure reason (HTTP status code or network error copy) into the indicator", () => {
		// Arrange: 元素引用变量 + error 类赋值位置（失败分支锚点）
		const name = lastUpdateVar();
		const classIdx = PAGE_HTML.search(
			new RegExp(`${name}\\.className\\s*=\\s*"[^"]*\\berror\\b|${name}\\.classList\\.(?:add|toggle)\\(\\s*"error"`)
		);
		expect(classIdx, "missing error-state assignment on #last-update").toBeGreaterThan(-1);
		const reasonKw = /HTTP|error\.message|网络|失败|offline|request failed/;

		// Assert: 原因落入元素 —— ① 元素 textContent 直接拼原因关键字；或
		// ② error 类赋值窗口（±500 字符）内同时出现元素 textContent 与原因
		// （经由失败助手写入的形状）
		const direct = new RegExp(`${name}\\.textContent\\s*=[^;\\n]*(?:HTTP|error\\.message|网络|失败|offline|request failed)`).test(PAGE_HTML);
		const window = PAGE_HTML.slice(Math.max(0, classIdx - 500), classIdx + 500);
		const viaWindow = new RegExp(`${name}\\.textContent`).test(window) && reasonKw.test(window);
		expect(direct || viaWindow, "failure reason must be written into #last-update").toBe(true);
	});

	it("should refresh the indicator from a successful fetch path (noteSuccess, tree poll or session poll)", () => {
		// Arrange: 元素引用变量或等价的 lastUpdate 助手命名
		const name = lastUpdateVar();
		const touch = new RegExp(`${name}\\b|lastUpdate|LastUpdate|last-update`);

		// Assert: 成功路径（noteSuccess / refreshTree / pollOnce / updateStatus /
		// tick 任一函数体）触达指示器 —— 具体接线位置宽容，但必须存在刷新点
		const wired = ["noteSuccess", "refreshTree", "pollOnce", "updateStatus", "tick"].some((fn) => {
			const start = PAGE_HTML.indexOf(`function ${fn}(`);
			if (start === -1) { return false; }
			const bodyStart = start + `function ${fn}(`.length;
			const next = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
			const end = next ? bodyStart + next.index : bodyStart + 1200;
			return touch.test(PAGE_HTML.slice(start, end));
		});
		expect(wired).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 本轮 B：状态 pill 移到转录区右上角、区域内吸顶（红阶段，字符串级）。
// 冻结契约：
//   B1. 顶栏 .topbar 片段不再含 id="status"（顶栏用例已同步收紧，当前红）；
//   B2. id="status" class="pill" 移入 .transcript-wrap，包在
//       <div class="transcript-head"> 里，位于 #crumbs 之后、#transcript
//       之前（indexOf 顺序锁定）；
//   B3. 新增 .transcript-head CSS 规则：position: sticky、top: 0、
//       justify-content: flex-end、background: var(--panel)（pill 右边缘与
//       .transcript-wrap 右边缘对齐 —— 右内边距为 0；该细则不在本组断言，
//       由 B3 规则体的 flex-end + 不透明背景间接约束）；
//   B4. 内容与更新逻辑不变（status | duration），updateStatusPill 仍操作
//       #status —— 既有 #status 文本逻辑用例（waiting / 未找到 / loading 等）
//       保留不动，本组不重复收录。
// 实现由 coder 落地；本组在 src/web/page.ts 未改时预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 状态药丸移至转录区右上角（B，红阶段，字符串级）", () => {
	it("should move the status pill into .transcript-wrap inside a .transcript-head div between #crumbs and #transcript", () => {
		// Arrange: 结构标记位置（indexOf 顺序比较）
		const wrapIdx = PAGE_HTML.indexOf('<section class="transcript-wrap">');
		const crumbsIdx = PAGE_HTML.indexOf('<nav id="crumbs"');
		const headIdx = PAGE_HTML.indexOf('<div class="transcript-head">');
		const statusIdx = PAGE_HTML.indexOf('id="status"');
		const transcriptIdx = PAGE_HTML.indexOf('<section id="transcript"');

		// Assert: 顺序锁定 wrap → crumbs → transcript-head/#status → transcript
		expect(wrapIdx, 'missing <section class="transcript-wrap">').toBeGreaterThan(-1);
		expect(crumbsIdx, "missing #crumbs nav").toBeGreaterThan(wrapIdx);
		expect(headIdx, 'missing <div class="transcript-head">').toBeGreaterThan(crumbsIdx);
		expect(statusIdx, "missing id=\"status\" inside .transcript-wrap").toBeGreaterThan(headIdx);
		expect(transcriptIdx, "missing #transcript section").toBeGreaterThan(statusIdx);

		// Assert: 药丸元素在 .transcript-wrap 片段内且 class 逐字（内容与
		// 更新逻辑不变的元素载体）
		const wrap = PAGE_HTML.slice(wrapIdx, transcriptIdx);
		const pillTag = wrap.match(/<\w+[^>]*id="status"[^>]*>/)?.[0] ?? "";
		expect(pillTag, "missing #status tag inside .transcript-wrap").not.toBe("");
		expect(pillTag).toContain('class="pill"');
	});

	it("should declare the .transcript-head rule as sticky, flex-end aligned and backed by the opaque panel background", () => {
		// Arrange: .transcript-head 规则声明体
		const rule = pageStyle().match(/\.transcript-head[^{}]*\{([^}]*)\}/)?.[1] ?? "";

		// Assert（当前应红）: 区域内吸顶 + 右对齐 + 不透明背景四件套
		expect(rule, "missing .transcript-head CSS rule").not.toBe("");
		expect(rule, ".transcript-head must be sticky").toMatch(/position\s*:\s*sticky/);
		expect(rule, ".transcript-head must pin to top: 0").toMatch(/top\s*:\s*0/);
		expect(rule, ".transcript-head must right-align its content").toMatch(/justify-content\s*:\s*flex-end/);
		expect(rule, ".transcript-head needs the opaque panel background").toMatch(/background\s*:\s*var\(--panel\)/);
	});
});

// ---------------------------------------------------------------------------
// 第 7 轮（cycle-2）契约 F（页面侧）：markdown 远程图片不自动加载（红阶段）。
//   F1. renderMarkdown 对 img[src] 逐个用内联 isAllowedImageSrc 过滤；
//   F2. 通过（data: / 内部 /api/image）保原样；不通过 → .remote-image 占位
//       锚点（href 仅在原 src 通过 isSafeHref 时设置：target="_blank"、
//       rel="noopener noreferrer"、文本 alt||URL；不通过 —— 尤其 javascript: /
//       空串 —— 不创建锚点，降级为纯文本占位），原 img 被替换移除，不留自动请求；
//   F3. 页面自有静态标记 0 个 <img> 标签（剔除 vendor 后）。isAllowedImageSrc
//       真值表与内联同源守卫见 test/subagent-web-markdown.test.ts。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 远程图片不自动加载（F，红阶段，字符串级）", () => {
	it("should gate every rendered img through isAllowedImageSrc inside renderMarkdown", () => {
		// Arrange: renderMarkdown 函数体
		const body = fnBody("renderMarkdown");

		// Assert: 元素选取 —— img（[src] 后缀宽容；外链中和修复后扩为
		// img[src], img[data-remote-src] 双选择器，两种形状均放行）
		expect(body).toMatch(/querySelectorAll\(\s*["']img(\[src\])?(\s*,\s*img\[data-remote-src\])?["']\s*\)/);

		// Assert: 白名单判定点（负向后视排除内联定义，只认调用）+ 守卫分流形状
		expect(body).toMatch(/(?<!function )isAllowedImageSrc\(/);
		expect(body).toMatch(/if\s*\(\s*!?isAllowedImageSrc\(/);
	});

	it("should replace a disallowed remote image with a .remote-image placeholder and drop the auto-loading img", () => {
		// Arrange: renderMarkdown 函数体与 img 占位分支片段
		const body = fnBody("renderMarkdown");
		const region = markdownImageRegion();

		// Assert: 占位类名逐字 + CSS 规则
		expect(PAGE_HTML).toContain("remote-image");
		expect(pageStyle()).toMatch(/\.remote-image\s*\{/);

		// Assert: 原 img 被替换/移除（replaceChild / replaceWith / remove 任一）
		expect(body).toMatch(/replaceChild\(|replaceWith\(\)|\.remove\(\)/);

		// Assert（契约 1 重写）: 占位锚点的 href 仅在原 src 通过 isSafeHref 后才
		// 设置 —— 锚点属性写入（.href = / setAttribute("href"）必须排在占位分支
		// 内 isSafeHref( 校验之后；旧契约「href=原 src 无条件赋值」把 javascript:
		// 注入写进了契约，整体作废。安全 src 仍保留 target="_blank" +
		// rel="noopener noreferrer"（C4 的 ±300 字符 noopener 守卫同窗成立）
		const guardIdx = region.indexOf("isSafeHref(");
		const hrefIdx = region.search(/\.href\s*=|setAttribute\(\s*"href"/);
		expect(guardIdx, "img placeholder region must validate the src via isSafeHref(").toBeGreaterThan(-1);
		expect(hrefIdx, "placeholder href assignment must come after the isSafeHref( guard").toBeGreaterThan(guardIdx);
		expect(region).toContain("_blank");
		expect(region).toContain("noopener noreferrer");

		// Assert: 占位文本 = alt，alt 缺失时回落 URL（src）
		expect(region).toMatch(/alt[\s\S]{0,60}?\|\|[\s\S]{0,40}?src/i);
	});

	it("should keep no static <img> tag in the page's own markup so nothing auto-requests before user action", () => {
		// Arrange: 剔除两段内联 vendor bundle 后的页面自有文本（vendor 可能
		// 合法地含 <img 字面，写法同 caret 守卫用例）
		const pageOwn = PAGE_HTML.split(MARKED_JS).join("").split(HIGHLIGHT_JS).join("");

		// Assert: 页面自有静态标记 0 个 <img> 标签 —— 图片只能经懒加载预览
		// （createElement("img") + blob URL）或占位锚点进入 DOM
		expect(pageOwn).not.toMatch(/<img[\s>]/);
	});
});

// ---------------------------------------------------------------------------
// 第 7 轮回归（契约 6，红阶段，字符串级）：打开深层任务时自动请求该节点子树。
//   6a. 页面定义 maybeExpand / ensureExpanded 函数（二选一），对当前
//       state.taskId 发起 request("/api/tree", { expand: … })，且该函数在页面
//       流程里被真实调用（声明之外至少一个调用点）；
//   6b. 成功后读取 result.expand.children，合并进 findNode(state.tree, …) 找到
//       的节点的 children，并调用 renderTree() 重渲染；
//   6c. 「已请求」标记防重复：request 发起前先守卫早退，并已把标记写入。
// 实现由 coder 落地；本组在 src/web/page.ts 未改时全部预期红。
// ---------------------------------------------------------------------------

/**
 * 抽 maybeExpand / ensureExpanded（二者任一）的函数体；两者都缺失时返回
 * null，由用例自身的 expect 报红（红因即「缺失自动展开函数」）。
 */
function expandFnBody(): { name: string; body: string } | null {
	for (const name of ["maybeExpand", "ensureExpanded"]) {
		const start = PAGE_HTML.indexOf(`function ${name}(`);
		if (start === -1) { continue; }
		const bodyStart = start + `function ${name}(`.length;
		const nextNamed = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
		const end = nextNamed ? bodyStart + nextNamed.index : bodyStart + 1200;
		return { name, body: PAGE_HTML.slice(bodyStart, end) };
	}
	return null;
}

describe("PAGE_HTML 打开深层任务自动请求子树（回归 6，红阶段，字符串级）", () => {
	it("should request the current task's subtree via request(\"/api/tree\", { expand: … }) from maybeExpand/ensureExpanded", () => {
		// Arrange
		const fn = expandFnBody();

		// Assert: 自动展开函数存在（maybeExpand / ensureExpanded 二选一）
		expect(fn, "missing maybeExpand/ensureExpanded function").not.toBeNull();

		// Assert: 请求形状 —— /api/tree 端点 + 对象字面量里的 expand: 参数
		expect(fn!.body).toMatch(/request\(\s*"\/api\/tree"\s*,\s*\{[^}]*\bexpand\s*:/);
		// 展开目标是当前选中的任务
		expect(fn!.body).toContain("state.taskId");
		// 且该函数在页面流程里被真实调用（声明之外至少一个调用点 ——
		// route / renderTree / refreshTree 任一接线均可）
		const callSites = PAGE_HTML.match(new RegExp(`${fn!.name}\\(`, "g")) ?? [];
		expect(callSites.length).toBeGreaterThanOrEqual(2);
	});

	it("should merge result.expand.children into the findNode(state.tree, …) node's children and re-render via renderTree()", () => {
		// Arrange
		const fn = expandFnBody();
		expect(fn, "missing maybeExpand/ensureExpanded function").not.toBeNull();
		const body = fn!.body;

		// Assert: 成功分支读取 result.expand（含 .children 取值），定位
		// state.tree 中的节点并写入其 children，最后重渲染
		expect(body).toContain("result.expand");
		expect(body).toMatch(/result\.expand[\s\S]{0,120}?\.children/);
		expect(body).toMatch(/findNode\(\s*state\.tree\s*,/);
		expect(body).toMatch(/\.children\s*=/);
		expect(body).toContain("renderTree()");
	});

	it("should guard against duplicate subtree requests with an already-requested marker written before the request", () => {
		// Arrange
		const fn = expandFnBody();
		expect(fn, "missing maybeExpand/ensureExpanded function").not.toBeNull();
		const body = fn!.body;
		const requestIdx = body.search(/request\(\s*"\/api\/tree"/);
		expect(requestIdx, "missing /api/tree request in the expand helper").toBeGreaterThan(-1);
		// 只看 request 之前的头部：守卫早退 + 标记写入都必须先于请求
		const head = body.slice(0, requestIdx);

		// Assert: 三种合法去重标记形状任一（对象/Map 键、Set.has/add、
		// state 布尔旗），且守卫（if … return）在标记写入之前、写入在请求之前
		const shapes: Array<{ guard: RegExp; write: RegExp }> = [
			{
				guard: /if\s*\([^)]*\[\s*(?:state\.)?taskId\s*\][^)]*\)\s*\{\s*return\b/,
				write: /\[\s*(?:state\.)?taskId\s*\]\s*=\s*(?:true|1)\b/,
			},
			{
				guard: /if\s*\([^)]*\.has\(\s*(?:state\.)?taskId\s*\)[^)]*\)\s*\{\s*return\b/,
				write: /\.add\(\s*(?:state\.)?taskId\s*\)/,
			},
			{
				guard: /if\s*\([^)]*(?:state\.)?\w*(?:xpanded|equested)\w*[^)]*\)\s*\{\s*return\b/,
				write: /(?:state\.)?\w*(?:xpanded|equested)\w*\s*=\s*true\b/,
			},
		];
		const matched = shapes.some((shape) => {
			const guard = head.search(shape.guard);
			const write = head.search(shape.write);
			return guard !== -1 && write !== -1 && guard < write;
		});
		expect(matched, "expand helper must early-return on an already-requested marker written before the request").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 独立审查缺口（第 7 轮后补）契约 1：远程图片占位锚点协议安全（Critical 配套）。
// 旧 F 组把「占位锚点 href=原 src 无条件赋值」写进了契约，javascript: 可注入；
// 新契约：占位锚点的 href 仅在原 src 通过 isSafeHref（http:/https:/页内 #）时
// 设置；不通过（尤其 javascript:、空串）→ 不创建锚点，降级为纯文本占位
// （span.remote-image 内只有文本）。字符串级无法真实执行 DOM 分支，取最强
// 可判定形状：守卫判定先于锚点创建/href 赋值（顺序锁）+ 纯文本降级形状存在。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 远程图片占位锚点协议安全（契约 1，红阶段，字符串级）", () => {
	it("should check the placeholder src with isSafeHref before creating the anchor or assigning its href", () => {
		// Arrange: renderMarkdown 的 img[src] 处理段
		const region = markdownImageRegion();

		// Assert: 守卫判定点存在（负向后视排除内联定义本身，只认调用）
		expect(region, "img placeholder branch must validate the src via isSafeHref(").toMatch(
			/(?<!function )isSafeHref\(/
		);

		// Assert: 锚点创建与 href 赋值都必须排在 isSafeHref( 校验之后 ——
		// javascript: 等不通过的 src 在校验处已被拦下，到不了创建/赋值
		const guardIdx = region.indexOf("isSafeHref(");
		const anchorIdx = region.search(/\bel\(\s*"a"\s*,/);
		const hrefIdx = region.search(/\.href\s*=|setAttribute\(\s*"href"/);
		expect(anchorIdx, "anchor creation must come after the isSafeHref( check").toBeGreaterThan(guardIdx);
		expect(hrefIdx, "href assignment must come after the isSafeHref( check").toBeGreaterThan(guardIdx);
	});

	it("should degrade an unsafe image src to a plain-text placeholder without creating an anchor", () => {
		// Arrange: renderMarkdown 的 img[src] 处理段
		const region = markdownImageRegion();

		// Assert: 纯文本降级形状任一 —— 不通过 isSafeHref 的 src 只留文本
		//（span.remote-image 内无 <a>）：文本节点、textContent 赋值、
		// el("span","remote-image",<text>) 直接带文本创建
		const textShapes = [
			/createTextNode\(/,
			/\.textContent\s*=/,
			/el\(\s*"span"\s*,\s*"remote-image"\s*,/,
		];
		expect(
			textShapes.some((shape) => shape.test(region)),
			"unsafe src must degrade to a plain-text remote-image placeholder"
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 独立审查缺口（第 7 轮后补）契约 3：expand 去重标记生命周期（Important 配套）。
// 现状：state.expanded[taskId] 一旦置位永不清除，而 refreshTree 每次 200 都用
// 新 state.tree 整体替换，上次合并的 children 丢失后该 taskId 永不重展开。
// 新契约：refreshTree 替换 state.tree 的邻近位置必须重置/失效 state.expanded
// （如 state.expanded = {} 或按代数失效），使已访问 taskId 在新树上可重新展开。
// ---------------------------------------------------------------------------

describe("PAGE_HTML expand 去重标记生命周期（契约 3，红阶段，字符串级）", () => {
	it("should reset or invalidate state.expanded in refreshTree right where state.tree is replaced", () => {
		// Arrange: refreshTree 函数体，state.tree 替换点
		const body = fnBody("refreshTree");
		const treeIdx = body.search(/state\.tree\s*=\s*Array\.isArray/);
		expect(treeIdx, "refreshTree must replace state.tree").toBeGreaterThan(-1);

		// Act: 替换点邻近窗口（前 350 / 后 450 字符 —— 覆盖紧邻的前后语句）
		const window = body.slice(Math.max(0, treeIdx - 350), treeIdx + 450);

		// Assert: 去重标记的清空/失效形状任一 —— 对象/Map/Set 重建、
		// 代数计数器重写、或逐键 delete 清空
		const resetShapes = [
			/state\.expanded\s*=\s*\{\s*\}/,
			/state\.expanded\s*=\s*Object\.create\(/,
			/state\.expanded\s*=\s*new Map\(/,
			/state\.expanded\s*=\s*new Set\(/,
			/state\.expanded\w*\s*=\s*(?:state\.)?gen\b/,
			/Object\.keys\(\s*state\.expanded\s*\)[\s\S]{0,80}?(?:delete|forEach)/,
		];
		expect(
			resetShapes.some((shape) => shape.test(window)),
			"refreshTree must reset/invalidate state.expanded where state.tree is replaced"
		).toBe(true);
	});

	it("should keep the per-taskId dedup marker write in maybeExpand so the reset actually re-enables expansion", () => {
		// Arrange: maybeExpand/ensureExpanded 函数体（既有回归 6 组的去重契约
		// 成对放置 —— 重置生命周期不得顺手删掉单次去重）
		const fn = expandFnBody();
		expect(fn, "missing maybeExpand/ensureExpanded function").not.toBeNull();

		// Assert: 标记仍按 taskId 逐键写入（重置后同一 taskId 才能在新树上
		// 重新请求展开）
		expect(fn!.body).toMatch(/\[\s*(?:state\.)?taskId\s*\]\s*=\s*(?:true|1)\b|\.add\(\s*(?:state\.)?taskId\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// 独立审查缺口（第 7 轮后补）契约 4：banner 优先级（mismatch 不被离线覆盖）。
// 现状：showMismatchBanner 与 noteFailure 复用同一 bannerEl，离线横幅可覆盖
// mismatch 文案。新契约：state.mismatch 为真时，noteFailure/noteSuccess 不得把
// banner 文案改为连接/离线文案或清空（mismatch 优先，持续显示
// 「页面代码与后端不匹配，请刷新（⌘⇧R）」）。
// ---------------------------------------------------------------------------

describe("PAGE_HTML mismatch 横幅优先级（契约 4，红阶段，字符串级）", () => {
	it("should guard the offline banner write in noteFailure behind state.mismatch so a version mismatch copy is never overwritten", () => {
		// Arrange: noteFailure 函数体与离线横幅写入点
		const body = fnBody("noteFailure");
		const bannerIdx = body.search(/bannerEl\.textContent\s*=\s*"Connection lost/);
		expect(bannerIdx, "noteFailure must carry the offline banner copy").toBeGreaterThan(-1);

		// Assert: mismatch 守卫分支存在且先于/包住离线横幅写入 ——
		// ① 写入前的函数体内已有 state.mismatch 早退，或
		// ② 写入点邻近窗口（前 250 / 后 200 字符）内存在 !state.mismatch 守卫
		const head = body.slice(0, bannerIdx);
		const window = body.slice(Math.max(0, bannerIdx - 250), bannerIdx + 200);
		const guardShapes = [
			/if\s*\(\s*state\.mismatch\s*\)\s*\{[\s\S]*?\breturn\b/.test(head),
			/if\s*\(\s*!state\.mismatch\s*\)/.test(window),
		];
		expect(
			guardShapes.some(Boolean),
			"noteFailure must not write the offline banner while state.mismatch is set"
		).toBe(true);
	});

	it("should keep the mismatch banner from being cleared by noteSuccess while state.mismatch is set", () => {
		// Arrange: noteSuccess 函数体
		const body = fnBody("noteSuccess");

		// Assert: clearBanner 调用受 !state.mismatch 守卫（mismatch 横幅持续
		// 显示，不被恢复路径清掉）；文案本体由 E1 组用例锁定
		expect(body).toMatch(/state\.mismatch/);
		expect(body).toMatch(/if\s*\(\s*!state\.mismatch\s*\)\s*\{[\s\S]{0,80}?clearBanner\(\)/);
	});
});

// ---------------------------------------------------------------------------
// 用户口径修订（第 8 轮）契约 B：打开页面时自动滚到最新（仅首次渲染，
// 红阶段，字符串级）。冻结契约：
//   B1. 同源内联：PAGE_HTML 含 scrollTargetTaskId.toString() 产出的完整函数
//       源码，调用点逐字 scrollTargetTaskId(state.tree, state.taskId)；
//   B2. state 新增两个布尔（初始 false）：autoScrolledOnce、userScrolledSidebar；
//   B3. function autoScrollSidebar()（命名锁定），renderTree() 挂行之后调用；
//   B4. 只滚一次：autoScrollSidebar 首行对 state.autoScrolledOnce 守卫，
//       滚动/跳过后置 state.autoScrolledOnce = true；
//   B5. 手动滚动后停用：boot() 为 treeEl 注册 wheel、touchstart/touchmove、
//       keydown 监听，回调置 state.userScrolledSidebar = true，
//       autoScrollSidebar 对其守卫；
//   B6. 只滚侧栏容器：autoScrollSidebar 内只出现 treeEl.scrollTop 赋值，
//       无 window.scroll*、scrollIntoView、transcriptEl.scrollTop；
//   B7. 已在视野内不动：rowRect/listRect 的 getBoundingClientRect() 比较后
//       早退（比较先于滚动赋值）；
//   B8. 深链优先：目标计算把 state.taskId 作为 selectedTaskId 传入，调用点
//       位于 autoScrollSidebar 内。
//   B9.（本轮 E①）渲染出的行数为 0 不消耗一次性机会（autoScrolledOnce 保持
//       false）且该守卫先于任何消耗点 —— 列表「空 → 非空」后仍自动滚动一次；
//   B10.（本轮 E②）treeEl.getBoundingClientRect().height === 0（侧栏折叠）时不置
//       autoScrolledOnce=true，改为记录待办；展开（expandSidebar()/applySidebar()
//       变为展开）且 !state.userScrolledSidebar 时补一次 autoScrollSidebar()。
// B9/B10 对应用例附于本组末尾；B1–B8 断言保留（首行守卫仍要在），新分支不破坏。
// 纯函数 scrollTargetTaskId 的语义用例见 test/subagent-web-tree-view.test.ts。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

/** 抽 `var state = { … };` 声明片段（对象字面量内首个 `};` 即声明结束）。 */
function stateDecl(): string {
	const start = PAGE_HTML.indexOf("var state = {");
	expect(start, "missing state object").toBeGreaterThan(-1);
	const end = PAGE_HTML.indexOf("};", start);
	expect(end, "missing state object end").toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end + 2);
}

/** 抽 function boot( 到 IIFE 收尾之间的脚本（boot 之后无具名函数，fnBody 不适用）。 */
function bootBody(): string {
	const start = PAGE_HTML.indexOf("function boot(");
	expect(start, "missing boot").toBeGreaterThan(-1);
	const end = PAGE_HTML.indexOf("})();", start);
	expect(end, "missing IIFE end after boot").toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end);
}

/**
 * 从 idx 起抽第一个 `{` 所在的花括号块（按花括号配平），供分支级断言 ——
 * 分支内不得出现的写入（如 autoScrolledOnce = true）靠块级范围而非窗口定界，
 * 避免窗口溢出到后续分支造成误判。
 */
function blockAt(source: string, idx: number): string {
	const open = source.indexOf("{", idx);
	expect(open, "missing block after index").toBeGreaterThan(-1);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "{") {
			depth += 1;
		} else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(idx, i + 1);
			}
		}
	}
	throw new Error("unbalanced braces after index " + idx);
}

/**
 * 抽 autoScrollSidebar 内折叠守卫（treeEl.getBoundingClientRect().height === 0，
 * 内联或经 listRect 变量均可）所在分支。缺失时 expect 直接报红（红因即「缺
 * 折叠守卫」）。
 */
function collapsedGuardBranch(): { body: string; branch: string } {
	const body = fnBody("autoScrollSidebar");
	let idx = body.search(/treeEl\.getBoundingClientRect\(\)\.height\s*===\s*0/);
	if (idx === -1) {
		const decl = body.match(/(?:var|let|const)\s+(\w+)\s*=\s*treeEl\.getBoundingClientRect\(\)/);
		if (decl) {
			idx = body.search(new RegExp(`${decl[1]}\\.height\\s*===\\s*0`));
		}
	}
	expect(idx, "missing collapsed guard: treeEl.getBoundingClientRect().height === 0").toBeGreaterThan(-1);
	return { body, branch: blockAt(body, idx) };
}

describe("PAGE_HTML 打开页面自动滚到最新（B，红阶段，字符串级）", () => {
	it("should inline the scrollTargetTaskId source verbatim and call it as scrollTargetTaskId(state.tree, state.taskId)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量；helper 与页面同模块图，
		// toString() 返回同一份转换后源码

		// Assert: 调用点逐字（深链优先的入参锁定）
		expect(PAGE_HTML).toContain("scrollTargetTaskId(state.tree, state.taskId)");

		// Assert: 完整函数源码逐字在页面内（删除 ${scrollTargetTaskId.toString()}
		// 插值即红，与 childSummary/ancestorIds 同模式的同源守卫）
		expect(PAGE_HTML).toContain(scrollTargetTaskId.toString());
	});

	it("should declare state.autoScrolledOnce and state.userScrolledSidebar as false booleans", () => {
		// Arrange: state 对象声明片段
		const decl = stateDecl();

		// Assert: 两个开关字段初始为布尔 false（逐字段）
		expect(decl).toMatch(/\bautoScrolledOnce\s*:\s*false\b/);
		expect(decl).toMatch(/\buserScrolledSidebar\s*:\s*false\b/);
	});

	it("should define function autoScrollSidebar() and call it from renderTree() after the rows are mounted", () => {
		// Arrange / Act: 命名锁定 + renderTree 函数体
		expect(PAGE_HTML).toContain("function autoScrollSidebar(");
		const renderTree = fnBody("renderTree");
		const listIdx = renderTree.search(/renderList\(/);
		const autoIdx = renderTree.search(/autoScrollSidebar\s*\(\s*\)/);

		// Assert: 先挂行（renderList）再滚动（autoScrollSidebar），调用点存在且靠后
		expect(listIdx, "renderTree must call renderList first").toBeGreaterThan(-1);
		expect(autoIdx, "renderTree must call autoScrollSidebar()").toBeGreaterThan(listIdx);
	});

	it("should guard autoScrollSidebar on state.autoScrolledOnce in its first line and set the flag afterwards", () => {
		// Arrange: 自动滚动函数体
		const body = fnBody("autoScrollSidebar");

		// Assert: 首行守卫 —— 声明后第一句（可隔注释）即读 state.autoScrolledOnce
		expect(body).toMatch(
			/function autoScrollSidebar\(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*if\s*\([^)]*state\.autoScrolledOnce/
		);

		// Assert: 滚动/跳过后置位 —— 只滚一次；置位晚于首次守卫读取
		const flagIdx = body.search(/state\.autoScrolledOnce\s*=\s*true/);
		expect(flagIdx, "autoScrollSidebar must set state.autoScrolledOnce = true").toBeGreaterThan(-1);
		expect(body.indexOf("state.autoScrolledOnce")).toBeLessThan(flagIdx);
	});

	it("should register wheel, touch and keydown listeners on treeEl in boot() that set state.userScrolledSidebar = true", () => {
		// Arrange: boot 函数区（boot 是最后一个具名函数，自定义抽取）
		const boot = bootBody();

		// Assert: 三类具体事件挂在 treeEl（侧栏容器）上
		expect(boot).toMatch(/treeEl\.addEventListener\(\s*"wheel"/);
		expect(boot).toMatch(/treeEl\.addEventListener\(\s*"keydown"/);
		expect(boot).toMatch(/treeEl\.addEventListener\(\s*"(?:touchstart|touchmove)"/);

		// Assert: 监听回调置位手动滚动标记
		expect(boot).toMatch(/state\.userScrolledSidebar\s*=\s*true/);
	});

	it("should bail out of autoScrollSidebar before scrolling once the user has scrolled the sidebar manually", () => {
		// Arrange: 自动滚动函数体
		const body = fnBody("autoScrollSidebar");
		const guardIdx = body.search(/if\s*\([^)]*state\.userScrolledSidebar/);
		const scrollIdx = body.search(/treeEl\.scrollTop\s*=/);

		// Assert: 守卫存在且先于滚动赋值
		expect(guardIdx, "autoScrollSidebar must guard on state.userScrolledSidebar").toBeGreaterThan(-1);
		expect(scrollIdx, "autoScrollSidebar must assign treeEl.scrollTop").toBeGreaterThan(guardIdx);
	});

	it("should scroll only the sidebar container from autoScrollSidebar with no window scroll, scrollIntoView or transcript scrolling", () => {
		// Arrange: 自动滚动函数体
		const body = fnBody("autoScrollSidebar");

		// Assert: 唯一滚动写入 = treeEl.scrollTop 赋值
		expect(body).toMatch(/treeEl\.scrollTop\s*=/);

		// Assert: 本功能不用 window.scroll*、scrollIntoView、transcriptEl.scrollTop
		expect(body).not.toMatch(/window\.scroll/);
		expect(body).not.toContain("scrollIntoView");
		expect(body).not.toContain("transcriptEl.scrollTop");
	});

	it("should early-return when the target row is already inside the tree container viewport via rowRect/listRect geometry", () => {
		// Arrange: 自动滚动函数体
		const body = fnBody("autoScrollSidebar");
		const rectCalls = body.match(/getBoundingClientRect\(\)/g) ?? [];

		// Assert: 行与容器各取一次几何矩形，四个边界字段都参与比较
		expect(rectCalls.length).toBeGreaterThanOrEqual(2);
		expect(body).toMatch(/rowRect\.top/);
		expect(body).toMatch(/rowRect\.bottom/);
		expect(body).toMatch(/listRect\.top/);
		expect(body).toMatch(/listRect\.bottom/);

		// Assert: 几何比较发生在滚动赋值之前，且比较后有早退 return
		const geoIdx = body.indexOf("rowRect");
		const scrollIdx = body.search(/treeEl\.scrollTop\s*=/);
		const returnIdx = body.indexOf("return", geoIdx);
		expect(geoIdx, "geometry comparison missing").toBeGreaterThan(-1);
		expect(scrollIdx, "treeEl.scrollTop assignment must come after the geometry check").toBeGreaterThan(geoIdx);
		expect(returnIdx, "geometry early return missing").toBeGreaterThan(geoIdx);
		expect(returnIdx).toBeLessThan(scrollIdx);
	});

	it("should compute the scroll target inside autoScrollSidebar with the deep-linked selection passed as scrollTargetTaskId(state.tree, state.taskId)", () => {
		// Arrange: 自动滚动函数体
		const body = fnBody("autoScrollSidebar");

		// Assert: 深链优先 —— selectedTaskId 逐字传 state.taskId，目标计算在
		// autoScrollSidebar 内完成（页面级调用点由本组第 1 条锁定）
		expect(body).toContain("scrollTargetTaskId(state.tree, state.taskId)");
	});

	// ---- B9/B10（本轮 E）：空列表不消耗机会 + 折叠待办补滚 -----------------

	it("should not consume the one-shot auto scroll when the rendered row count is 0 (empty → non-empty still scrolls once)", () => {
		// Arrange: 自动滚动函数体 + 行数为 0 的守卫（rows/nodes 变量名宽容，
		// 亦接受直接 querySelectorAll(...).length === 0 的写法）
		const body = fnBody("autoScrollSidebar");
		const zeroIdx = body.search(
			/if\s*\(\s*(?:(?:!\s*)?(?:rows|nodes)\.length|(?:rows|nodes)\.length\s*(?:===|<|<=)\s*0|treeEl\.querySelectorAll\([^)]*\)\.length\s*===\s*0|!\s*treeEl\.querySelectorAll)/
		);
		expect(zeroIdx, "missing rendered-row-count-0 guard in autoScrollSidebar").toBeGreaterThan(-1);

		// Act: 该分支的花括号块
		const branch = blockAt(body, zeroIdx);

		// Assert: 提前 return 且不置 autoScrolledOnce —— 空列表不消耗一次性机会
		expect(branch, "row-count-0 branch must early-return").toMatch(/\breturn\b/);
		expect(branch, "row-count-0 branch must not consume the one-shot").not.toMatch(/autoScrolledOnce\s*=\s*true/);

		// Assert: 消耗点（= true）仍存在于其它分支，且行数守卫先于首个消耗点 ——
		// 否则空树时会在守卫之前被吃掉机会，「空 → 非空」不再自动滚动
		const flagIdx = body.search(/state\.autoScrolledOnce\s*=\s*true/);
		expect(flagIdx, "one-shot consumption must still exist elsewhere").toBeGreaterThan(-1);
		expect(zeroIdx, "empty-list guard must precede any one-shot consumption").toBeLessThan(flagIdx);
	});

	it("should not set autoScrolledOnce when the sidebar is collapsed (height === 0) and record a pending flag instead", () => {
		// Arrange: 折叠守卫分支（treeEl.getBoundingClientRect().height === 0）
		const { branch } = collapsedGuardBranch();

		// Assert: 提前 return 且不置 autoScrolledOnce；改为记录待办 —— 分支内
		// 写入某个 state.<flag> = true（旗标名由实现自定），且不能是一次性机会
		// 本身或手动滚动标记
		expect(branch, "collapsed branch must early-return").toMatch(/\breturn\b/);
		expect(branch, "collapsed branch must not consume the one-shot").not.toMatch(/autoScrolledOnce\s*=\s*true/);
		const pending = branch.match(/state\.(\w+)\s*=\s*true/);
		expect(pending, "collapsed branch must record a pending flag instead of consuming the one-shot").not.toBeNull();
		expect(pending![1]).not.toBe("autoScrolledOnce");
		expect(pending![1]).not.toBe("userScrolledSidebar");
	});

	it("should catch up with one autoScrollSidebar() when the sidebar expands while state.userScrolledSidebar stays false", () => {
		// Arrange: 待办旗标名取自折叠分支的写入（与上一条用例同源）
		const { branch } = collapsedGuardBranch();
		const flag = (branch.match(/state\.(\w+)\s*=\s*true/) ?? [])[1];
		expect(flag, "missing pending flag recorded in the collapsed branch").toBeTruthy();
		const expandBody = fnBody("expandSidebar");
		const combined = expandBody + "\n" + fnBody("applySidebar");

		// Act: 展开路径上的补滚调用点
		const callIdx = combined.search(/autoScrollSidebar\s*\(\s*\)/);

		// Assert: expandSidebar()/applySidebar() 之一补一次 autoScrollSidebar()，
		// 且调用点之前已有 !state.userScrolledSidebar 门控与待办旗标读取
		expect(callIdx, "missing autoScrollSidebar() catch-up on the expand path").toBeGreaterThan(-1);
		const guardIdx = combined.search(/!state\.userScrolledSidebar/);
		expect(guardIdx, "catch-up must be gated on !state.userScrolledSidebar").toBeGreaterThan(-1);
		expect(guardIdx).toBeLessThan(callIdx);
		expect(combined.slice(0, callIdx), `catch-up must read the pending flag state.${flag}`).toContain(`state.${flag}`);

		// Assert: 若补滚只挂在 applySidebar（每次布局同步都会执行），必须显式
		// 门控「变为展开」；挂在 expandSidebar 内则该函数本身即展开语义
		if (!expandBody.includes("autoScrollSidebar")) {
			expect(combined.slice(0, callIdx).search(/expanded|collapsed/i)).toBeGreaterThan(-1);
		}
	});
});

// ---------------------------------------------------------------------------
// 本轮 A：冷深链完整面包屑（服务端路径接口 + 客户端，红阶段，字符串级）。
// 冻结契约（详见文件头 A 段）：
//   A1. 页面含字面 "/api/path"（GET /api/path?taskId=<id>）；
//   A2. state 新增 path: []、pathFound: null、pathTask: null、pathFor: null；
//   A3. function ensurePath( 经 request("/api/path", { taskId }) 拉取，成功写入
//       四字段后调用 renderCrumbs() 与 updateStatus()，失败不重试成环；
//       route() 命中 taskId 时调用它；
//   A4. renderCrumbs()：pathFor === taskId 时按 state.path 渲染每节（label =
//       segment.task 或 id 前 8 位，dot 取 segment.status），否则回退
//       ancestorIds(state.tree, state.taskId)；当前节 label 取 state.pathTask
//       或树节点；pathFound === false 追加 .crumb-not-found（「未找到该任务」+
//       aria-current="page"）；
//   A5. goBack()：祖先链为空（depth≤1）时提前 return、不写 location.hash；
//       非空时回直接上级（服务端 path 归一化链末节）（既有两用例已按此
//       改写，此处不重复）；
//   A6. 任务不存在落点：转录区 .task-not-found（「未找到该任务」+
//       a.back-to-list[href="#/"]["返回任务列表」），状态药丸同文案，切走清除。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 冷深链完整面包屑（本轮 A，红阶段，字符串级）", () => {
	it("should request the server-side crumb path via the literal \"/api/path\" endpoint", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 页面调用 GET /api/path?taskId=<id> —— 端点字面逐字锁定
		expect(PAGE_HTML).toContain('"/api/path"');
	});

	it("should declare the new path state fields with the frozen initial values", () => {
		// Arrange: state 对象声明片段
		const decl = stateDecl();

		// Assert: 四个字段与初始值逐字（path 承载服务端路径，pathFound 三态
		// null/true/false，pathTask 当前节标题，pathFor 归属任务）
		expect(decl).toMatch(/\bpath\s*:\s*\[\]/);
		expect(decl).toMatch(/\bpathFound\s*:\s*null\b/);
		expect(decl).toMatch(/\bpathTask\s*:\s*null\b/);
		expect(decl).toMatch(/\bpathFor\s*:\s*null\b/);
	});

	it("should define ensurePath() and fetch the path through request(\"/api/path\", { taskId: … })", () => {
		// Arrange: ensurePath 函数体（缺失时 fnBody 直接报红）
		const body = fnBody("ensurePath");

		// Assert: 命名锁定 + 请求形状 —— 端点字面 + 对象字面量里的 taskId 参数
		expect(PAGE_HTML).toContain("function ensurePath(");
		expect(body).toMatch(/request\(\s*"\/api\/path"\s*,\s*\{[^}]*taskId\s*:/);
	});

	it("should write path/pathFound/pathTask/pathFor on success and then refresh the crumbs and the status pill", () => {
		// Arrange: ensurePath 函数体
		const body = fnBody("ensurePath");

		// Assert: 四个字段都被写入（= 非 === 比较）
		for (const field of ["path", "pathFound", "pathTask", "pathFor"]) {
			expect(body, `ensurePath must write state.${field}`).toMatch(new RegExp(`state\\.${field}\\s*=(?!=)`));
		}

		// Assert: 成功写入（以 pathFor 归属写入为代表）先于 renderCrumbs() 与
		// updateStatus() 调用 —— 顺序锁定「写入后刷新」
		const writeIdx = body.search(/state\.pathFor\s*=(?!=)/);
		const crumbsIdx = body.search(/renderCrumbs\(\)/);
		const statusIdx = body.search(/updateStatus\(\)/);
		expect(crumbsIdx, "ensurePath must call renderCrumbs()").toBeGreaterThan(writeIdx);
		expect(statusIdx, "ensurePath must call updateStatus()").toBeGreaterThan(writeIdx);
	});

	it("should not retry the /api/path fetch in a loop on failure", () => {
		// Arrange: ensurePath 函数体
		const body = fnBody("ensurePath");

		// Assert: 单次请求 + 无自递归 —— 失败不重试成环（body 含声明处 1 次
		// ensurePath(，request("/api/path" 也只 1 处，且无定时器重试）
		expect((body.match(/request\(\s*"\/api\/path"/g) ?? []).length, "ensurePath must issue exactly one /api/path request").toBe(1);
		expect((body.match(/ensurePath\s*\(/g) ?? []).length, "ensurePath must not recurse into itself").toBe(1);
		expect(body).not.toMatch(/setTimeout\([^)]*ensurePath|setInterval\([^)]*ensurePath/);
	});

	it("should call ensurePath() from route() when a taskId is routed", () => {
		// Arrange: route 函数体
		const body = fnBody("route");

		// Assert: 命中 taskId 的分支内调用 ensurePath（深链 #/t/<id> 经
		// hashchange → route 即拉取服务端路径）
		expect(body).toMatch(/if\s*\(\s*state\.taskId\s*\)\s*\{[\s\S]{0,400}?ensurePath\(/);
	});

	it("should render the crumb chain from state.path when state.pathFor === state.taskId, falling back to ancestorIds otherwise", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 服务端路径优先的分流判据（等号两侧书写顺序宽容）+ state.path 读取
		const pathIdx = body.search(/state\.pathFor\s*===\s*state\.taskId|state\.taskId\s*===\s*state\.pathFor/);
		expect(pathIdx, "missing state.pathFor === state.taskId gate in renderCrumbs").toBeGreaterThan(-1);
		expect(body, "renderCrumbs must read state.path").toMatch(/\bstate\.path\b/);

		// Assert: 树内回退保留且排在服务端路径分支之后（否则回退 ancestorIds）
		const fallbackIdx = body.search(/ancestorIds\(\s*state\.tree\s*,\s*state\.taskId\s*\)/);
		expect(fallbackIdx, "ancestorIds fallback must stay in renderCrumbs").toBeGreaterThan(-1);
		expect(fallbackIdx).toBeGreaterThan(pathIdx);
	});

	it("should label each path segment through crumbLabel(segment.task, id) and dot it with segment.status", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 每节 label 走 crumbLabel（任务正文→单行短标签，id 前 8 位
		// 兜底在 helper 内）；dot 取节状态（动态拼接，禁硬编码状态点的断言由
		// 既有 B 组用例锁定）
		expect(body).toMatch(/crumbLabel\(\s*segment\.task\s*,/);
		expect(body).toMatch(/dot-/);
		expect(body).toMatch(/\.status\b/);
	});

	it("should render every crumb label inside a .crumb-label span with single-line ellipsis truncation", () => {
		// Arrange: renderCrumbs 函数体 + 样式表
		const body = fnBody("renderCrumbs");
		const style = pageStyle();

		// Assert: 三处 label（path 节、树上溯节、当前节）都包在 .crumb-label 内，
		// 否则超长任务正文会把面包屑折成多行段落（当前段被挤出首屏）
		const spans = body.match(/el\(\s*"span"\s*,\s*"crumb-label"/g) ?? [];
		expect(spans.length).toBe(3);

		// Assert: 单行截断样式挂在 .crumb-label 上（nowrap + ellipsis + 可收缩）
		const rule = style.match(/\.crumb-label\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(rule, "missing .crumb-label rule").not.toBe("");
		expect(rule).toMatch(/white-space:\s*nowrap/);
		expect(rule).toMatch(/text-overflow:\s*ellipsis/);
		expect(rule).toMatch(/overflow:\s*hidden/);
	});

	it("should take the current crumb label from state.pathTask with the tree node as fallback", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 当前节 label 数据源 state.pathTask 出现在 renderCrumbs 内，
		// 且与树节点取值（.task / 文本节点）同窗
		const idx = body.search(/state\.pathTask/);
		expect(idx, "missing state.pathTask in renderCrumbs").toBeGreaterThan(-1);
		const win = body.slice(Math.max(0, idx - 250), idx + 250);
		expect(win).toMatch(/\.task\b|createTextNode/);
	});

	it("should append a .crumb-not-found crumb carrying 未找到该任务 and aria-current=page when pathFound === false", () => {
		// Arrange: renderCrumbs 函数体
		expect(PAGE_HTML).toContain("crumb-not-found");
		const body = fnBody("renderCrumbs");

		// Act: 追加点邻近窗口
		const idx = body.indexOf("crumb-not-found");
		expect(idx, "missing crumb-not-found in renderCrumbs").toBeGreaterThan(-1);
		const win = body.slice(Math.max(0, idx - 350), idx + 350);

		// Assert: 判据（pathFor 已由上一用例锁定，此处锁 pathFound === false 的
		// 精确比较）、文案逐字、aria-current 标注
		expect(win).toMatch(/state\.pathFound\s*===\s*false/);
		expect(win).toContain("未找到该任务");
		expect(win).toMatch(/aria-current/);
	});

	it("should show a .task-not-found block in the transcript with 未找到该任务 and a back-to-list link when pathFound === false", () => {
		// Arrange: 任务不存在落点的创建处（页面首个 task-not-found 出现点）
		const idx = PAGE_HTML.indexOf("task-not-found");
		expect(idx, "missing task-not-found block").toBeGreaterThan(-1);
		const win = PAGE_HTML.slice(Math.max(0, idx - 500), idx + 600);

		// Assert: 挂在转录区、判据为 pathFound === false、文案与返回链接逐字
		// （class back-to-list、href "#/"、文本「返回任务列表」）
		expect(win).toMatch(/transcriptEl/);
		expect(win).toMatch(/state\.pathFound\s*===\s*false/);
		expect(win).toContain("未找到该任务");
		expect(win).toContain('class="back-to-list"');
		expect(win).toContain("返回任务列表");
		expect(win).toMatch(/href\s*=\s*"#\/"|["']#\/["']/);
	});

	it("should set the status pill text to 未找到该任务 when pathFound === false", () => {
		// Arrange: updateStatusPill 函数体
		const body = fnBody("updateStatusPill");

		// Assert: 药丸分支读取 pathFound 并写出同一份文案
		expect(body).toMatch(/state\.pathFound/);
		expect(body).toContain("未找到该任务");
	});

	it("should clear the not-found state when navigating to another route", () => {
		// Arrange: route() 与 clearTranscript() 两个函数体
		const reset = /state\.pathFound\s*=\s*null(?!=)/;

		// Assert: 切走其它路由（route 重算 / 换页清理）时把 pathFound 复位，
		// 遗留的 false 不得让下一页继续显示「未找到该任务」
		const inRoute = reset.test(fnBody("route"));
		const inClear = reset.test(fnBody("clearTranscript"));
		expect(inRoute || inClear, "pathFound must be reset when the route changes").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 本轮 B：failed/rejected 药丸优先（红阶段，字符串级）。冻结契约：
//   updateStatusPill() 解析到的节点 status 为 failed/rejected 时，药丸 class 为
//   pill-failed/pill-rejected、文本以该状态开头，且该判断必须早于 state.waiting
//   分支（等待态不得盖住失败态）。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML failed/rejected 药丸优先于 waiting（本轮 B，红阶段，字符串级）", () => {
	it("should decide the failed/rejected pill before the state.waiting branch in updateStatusPill", () => {
		// Arrange: updateStatusPill 函数体 + 三个判定点位置
		const body = fnBody("updateStatusPill");
		const waitingIdx = body.search(/state\.waiting/);
		expect(waitingIdx, "missing state.waiting branch in updateStatusPill").toBeGreaterThan(-1);
		const failedIdx = body.search(/["']failed["']/);
		const rejectedIdx = body.search(/["']rejected["']/);

		// Assert: 两个状态判据都存在，且都早于 state.waiting 分支 —— 顺序锁定
		expect(failedIdx, "missing failed judgement in updateStatusPill").toBeGreaterThan(-1);
		expect(rejectedIdx, "missing rejected judgement in updateStatusPill").toBeGreaterThan(-1);
		expect(failedIdx, "failed judgement must come before the state.waiting branch").toBeLessThan(waitingIdx);
		expect(rejectedIdx, "rejected judgement must come before the state.waiting branch").toBeLessThan(waitingIdx);
	});

	it("should paint pill-failed/pill-rejected and a status-prefixed text inside that earlier branch", () => {
		// Arrange: failed/rejected 判断与 state.waiting 之间的分支片段
		const body = fnBody("updateStatusPill");
		const failedIdx = body.search(/["']failed["']/);
		const waitingIdx = body.search(/state\.waiting/);
		expect(failedIdx).toBeGreaterThan(-1);
		expect(waitingIdx).toBeGreaterThan(failedIdx);
		const branch = body.slice(failedIdx, waitingIdx);

		// Assert: 分支内写 className（pill-failed/pill-rejected，pill- 前缀逐字）
		expect(branch).toMatch(/className\s*=/);
		expect(branch).toMatch(/pill-/);

		// Assert: 文本以该状态开头 —— 三形态任一：字面 "failed…"/"rejected…"、
		// (node.status … 动态拼接、先取 status 变量再写 textContent
		expect(branch).toMatch(/textContent\s*=/);
		const textStarts = [
			/[A-Za-z_$][\w$]*\.textContent\s*=\s*(?:["']failed|["']rejected)/,
			/[A-Za-z_$][\w$]*\.textContent\s*=\s*\(?\s*[\w.]*\bstatus\b/,
			/=\s*[\w.]*\bstatus\b[^;]{0,120};[\s\S]{0,200}?\.textContent\s*=/,
		];
		expect(
			textStarts.some((shape) => shape.test(branch)),
			"failed/rejected pill text must start with the status"
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 本轮 C：行高单行 32px + 容器查询优先级降级（红阶段，字符串级）。冻结契约：
//   C1. .tree-list 建立容器查询上下文 container-type: inline-size，注释写明
//       「单行 32px；降级顺序 耗时 → taskId 短码 → 聚合徽章；永不折行」；
//   C2.（审阅修复目标 7 重标定）阈值固定：(max-width: 239px) 隐藏 .elapsed、
//       (max-width: 219px) 隐藏 .tid、(max-width: 199px) 再压 .child-summary
//       （默认侧栏内容宽约 264px 时三项全部可见）；.child-summary 默认即带
//       min-width:0/overflow:hidden/text-overflow:ellipsis/white-space:nowrap；
//   C3. .task-line 继续单行省略号截断（nowrap 断言并入既有省略号用例）。
// .node 单行 32px 契约见既有「.node 节奏」用例（本轮已改写）。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 单行 32px 容器查询降级（本轮 C，红阶段，字符串级）", () => {
	it("should make .tree-list a container query context with the verbatim degrade-order note", () => {
		// Arrange / Act: 样式表 + 降级顺序注释所在窗口
		const style = pageStyle();

		// Assert: .tree-list 规则内建立容器查询上下文
		expect(style).toMatch(/\.tree-list\s*\{[^}]*container-type:\s*inline-size/);

		// Assert: 注释逐字 —— 位于 /* … */ 注释内，「单行 32px」在前，降级顺序
		// 三项（耗时 → taskId 短码 → 聚合徽章）按序，收尾「永不折行」
		const noteIdx = PAGE_HTML.indexOf("降级顺序");
		expect(noteIdx, "missing degrade-order comment").toBeGreaterThan(-1);
		expect(PAGE_HTML.lastIndexOf("/*", noteIdx)).toBeGreaterThan(PAGE_HTML.lastIndexOf("*/", noteIdx));
		const win = PAGE_HTML.slice(Math.max(0, noteIdx - 120), noteIdx + 220);
		expect(win).toContain("单行 32px");
		expect(win).toContain("耗时");
		expect(win).toContain("taskId 短码");
		expect(win).toContain("聚合徽章");
		expect(win).toContain("永不折行");
		expect(win.indexOf("耗时")).toBeLessThan(win.indexOf("taskId 短码"));
		expect(win.indexOf("taskId 短码")).toBeLessThan(win.indexOf("聚合徽章"));
	});

	it("should hide .elapsed at the recalibrated 239px threshold and .tid at 219px through @container queries", () => {
		// Arrange / Act: 样式表与两个重标定阈值位置（审阅修复目标 7：
		// 419/339/259 → 239/219/199，默认侧栏内容宽约 264px 时三项全部可见）
		const style = pageStyle();
		expect(style).toContain("@container");

		// Assert: (max-width: 239px) 块内隐藏 .elapsed —— 阈值必须紧随
		// @container（绑定在容器查询上，而非散落的媒体查询）
		const elapsedIdx = style.search(/@container\s*\(max-width:\s*239px\)/);
		expect(elapsedIdx, "missing 239px container threshold").toBeGreaterThan(-1);
		const elapsedWin = style.slice(elapsedIdx, elapsedIdx + 260);
		expect(elapsedWin).toMatch(/\.elapsed/);
		expect(elapsedWin).toMatch(/display:\s*none/);

		// Assert: (max-width: 219px) 块内隐藏 .tid
		const tidIdx = style.search(/@container\s*\(max-width:\s*219px\)/);
		expect(tidIdx, "missing 219px container threshold").toBeGreaterThan(-1);
		const tidWin = style.slice(tidIdx, tidIdx + 260);
		expect(tidWin).toMatch(/\.tid\b/);
		expect(tidWin).toMatch(/display:\s*none/);

		// Assert: 降级顺序保持 耗时 → taskId 短码（239 先于 219）；旧阈值
		// 419/339 字面退役（含注释中的 <420px/<340px 旧口径）
		expect(elapsedIdx).toBeLessThan(tidIdx);
		expect(style, "old 419px threshold must be gone").not.toContain("419px");
		expect(style, "old 339px threshold must be gone").not.toContain("339px");
	});

	it("should degrade .child-summary at the recalibrated 199px container threshold", () => {
		// Arrange / Act: 样式表与 199px 阈值块（审阅修复目标 7：260 → 199）
		const style = pageStyle();
		const idx = style.search(/@container\s*\(max-width:\s*199px\)/);

		// Assert: 末级降级阈值重标定，199px 块触达 .child-summary 并再压宽度。
		// 省略号四件套（min-width:0 / overflow:hidden / text-overflow:ellipsis /
		// white-space:nowrap）改由默认规则用例锁定 —— 默认即不横向溢出，
		// 容器块只在更窄时进一步压缩
		expect(idx, "missing 199px container threshold").toBeGreaterThan(-1);
		const win = style.slice(idx, idx + 320);
		expect(win).toMatch(/\.child-summary/);
		expect(win).toMatch(/(?:max-width|overflow):\s*[^;]+;/);
		expect(style, "old 259px threshold must be gone").not.toContain("259px");

		// Assert: 降级顺序保持 耗时(239) → taskId(219) → 聚合徽章(199)
		const tidIdx = style.search(/@container\s*\(max-width:\s*219px\)/);
		expect(tidIdx, "missing 219px container threshold").toBeGreaterThan(-1);
		expect(idx).toBeGreaterThan(tidIdx);
	});
});

// ---------------------------------------------------------------------------
// 本轮（page.ts 审阅修复目标 1–8，红阶段，字符串级）：上一轮改动经审阅发现
// 的真实缺陷与测试假绿，先锁契约再修实现：
//   1. .reason 退役（本轮 A：行内不再显示拒绝原因），仅 .node-error 在行外 ——
//      .reason 元素与 .reason CSS 规则整体移除，node.reason 改作行 title 摘要；
//      .node-error CSS 不得使用 flex-basis: 100%；渲染侧把 node-error 挂到
//      .node 之外（node-group 包裹层、非 row 容器 appendChild 或 treeEl 直挂），
//      而不是 row.appendChild（否则 failed 行高爆成数百 px、.task-line 被压到
//      0 宽）；
//   2. 正常行（无 reason/errorText）高度恰为 32px：.node 用固定 height +
//      box-sizing: border-box（收紧断言落在既有「.node 单行」用例），
//      .badge box-sizing: border-box + height ≤ 20px（--lh-row）；
//   3. 冷深链到「树外」节点（finished/recent/pending）时药丸不得永久 loading ——
//      updateStatusPill 在无树节点时回退 state.pathTask.status 渲染
//      pill-<status>；"loading..." 仅在树节点与 state.pathTask 都缺席时出现；
//   4. /api/path 请求失败不得压制 ancestorIds 回退 —— ensurePath 的 catch 不写
//      state.pathFor（保持 null），goBack 在 pathFor !== taskId 时用 ancestorIds；
//   5. 路由竞态守卫：ensurePath 成功与失败 handler 都以
//      state.taskId !== taskId 提前 return 丢弃过期响应；
//   6. found 生产端判定：state.pathFound 的赋值右侧引用 result.found，不得硬编码；
//   7. 容器降级阈值重标定 419/339/259 → 239/219/199（旧断言已在原组更新），
//      .child-summary 默认即带 min-width:0/overflow:hidden/text-overflow:ellipsis/
//      white-space:nowrap（任何宽度都不横向溢出）；
//   8. not-found 时 aria-current="page" 只出现一次（.crumb-not-found 与当前
//      crumb 不可同时带）；state.pathTask 无 startedAt 时药丸文本无尾部 " | "。
// 其中 5/6 为已满足项的回归锁（当前应绿），其余在 src/web/page.ts 未修时预期红。
// 实现由 coder 落地。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 审阅修复目标 1–8（红阶段，字符串级）", () => {
	// ---- 1. .reason 退役；仅 .node-error 留在 .node 行外 ---------------------

	it("should keep .node-error free of flex-basis: 100% and retire the .reason rule entirely", () => {
		// Arrange: 样式表规则
		const style = pageStyle();
		const errorBody = style.match(/\.node-error\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: .node-error 规则仍在且不使用 flex-basis: 100% —— 该声明曾把
		// 错误面板压回 .node 的 nowrap flex 行内，failed 行高爆成数百 px、
		// .task-line 被压到 0 宽
		expect(errorBody, "missing .node-error rule").not.toBe("");
		expect(errorBody, ".node-error must not use flex-basis: 100%").not.toMatch(/flex-basis:\s*100%/);

		// Assert（本轮 A）: .reason 规则随行内原因块退役 —— 仅 .node-error 留在行外
		expect(style, ".reason rule must be retired").not.toMatch(/\.reason\s*\{/);
	});

	it("should mount the error panel outside the .node row (sibling block below it; the .reason element is retired)", () => {
		// Arrange: </style> 之后的脚本区 + 错误面板创建点
		const script = PAGE_HTML.slice(PAGE_HTML.indexOf("</style>"));

		// Assert（负向）: 错误面板不得 row.appendChild —— 挂进 .node 行本体就会
		// 落回 nowrap flex 行内（审阅确认的缺陷形状）；.reason 元素同步退役
		expect(script, "error panel must not be appended into the .node row").not.toMatch(
			/row\.appendChild\(\s*errorEl\s*\)/
		);
		expect(script, 'the "reason" element must be retired').not.toMatch(/el\(\s*"div"\s*,\s*"reason"/);

		// Assert（正向）: 错误面板创建点 ±400 字符窗口内存在非 row 容器的
		// appendChild（node-group 包裹层 / treeEl 直挂均可），或页面存在
		// node-group 类包裹层创建
		const errorIdx = script.search(/errorPanel\(\s*node\s*\)/);
		expect(errorIdx, "missing error panel render site").toBeGreaterThan(-1);
		const win = script.slice(Math.max(0, errorIdx - 400), errorIdx + 400);
		const receivers = [...win.matchAll(/([\w$]+)\.appendChild\(/g)].map((m) => m[1]);
		const outsideShape =
			receivers.some((name) => name !== "row") ||
			/el\(\s*"div"\s*,\s*"node-(?:group|wrap|item|main)/.test(script);
		expect(
			outsideShape,
			"error panel must be mounted on a non-row container (node-group / treeEl), not inside the .node row"
		).toBe(true);
	});

	// ---- 2. .badge 高度 ≤ 20px（.node 精确 32px 的配套，收紧在既有用例）----

	it("should cap .badge at 20px tall via box-sizing: border-box and a fixed height", () => {
		// Arrange: .badge 规则声明体
		const badgeRule = pageStyle().match(/\.badge\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: border-box + 固定高（字面 20px 或等价 --lh-row 令牌；max-height
		// 等价放行）—— 否则 1px 边框 + 内容把徽章撑出 32px 行
		expect(badgeRule, "missing .badge rule").not.toBe("");
		expect(badgeRule).toMatch(/box-sizing:\s*border-box/);
		expect(badgeRule).toMatch(/(?:max-)?height:\s*(?:20px|var\(--lh-row\))/);
	});

	// ---- 3. 树外节点药丸回退（不得永久 loading）---------------------------

	it("should paint pill-<status> from the pathTask-backed fallback when the tree has no node", () => {
		// Arrange: updateStatusPill 函数体 + 通用回退源声明
		const body = fnBody("updateStatusPill");
		const decl = body.match(/(?:var|let|const)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\|\|\s*)?state\.pathTask/);
		expect(decl, "updateStatusPill must read state.pathTask as a general fallback").not.toBeNull();
		const meta = (decl as RegExpExecArray)[1];

		// Act: 收集所有 "pill pill-" 上色语句（failed/rejected 分支 + 通用最终
		// 分支），最后一个即通用药丸
		const paints = [...body.matchAll(/"pill pill-"\s*\+\s*([^;]+);/g)];
		expect(paints.length, "updateStatusPill must paint pill-<status> for both the failed branch and the generic branch").toBeGreaterThanOrEqual(2);
		const generic = paints[paints.length - 1][1];

		// Act: 合法状态来源 = 回退源本身（meta.status）或由其派生的共享
		// status 变量（var status = meta && meta.status ? …）；仅树节点
		// （pillNode.status）不算 —— 排除点号属性访问，避免 pillNode.status
		// 里的 "status" 子串误判通过
		const derived = [...body.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=/g)]
			.map((m) => m[1])
			.filter((name) => new RegExp(`(?:var|let|const)\\s+${name}\\s*=[^;\\n]*${meta}\\b`).test(body));
		const allowed = [meta, ...derived];

		// Assert: 通用分支的状态来源可回溯到 state.pathTask —— 无树节点时
		// 药丸渲染 pill-<status> 而非 loading
		expect(
			allowed.some((name) => new RegExp(`(?<![\\w$.])${name}\\b`).test(generic)),
			`generic pill paint (${generic}) must fall back to the state.pathTask-backed status, not the tree node only`
		).toBe(true);
	});

	it("should write 'loading...' only when both the tree node and state.pathTask are absent", () => {
		// Arrange: updateStatusPill 函数体 + loading 写入点
		const body = fnBody("updateStatusPill");
		const idx = body.indexOf('"loading..."');
		expect(idx, "missing loading... pill text").toBeGreaterThan(-1);
		const gate = body.slice(Math.max(0, idx - 350), idx);

		// Assert: loading 写入的守卫必须含 pathTask 缺席判定 —— 直接判
		// !state.pathTask、判聚合回退源 !pillMeta（其声明含 pathTask，由上一
		// 用例锁定）、或树节点与 pathTask 双缺席；仅 !pillNode（树节点）不满足
		const gateShapes = [
			/!\s*state\.pathTask/,
			/!\s*pillMeta\b/,
			/!\s*[\w$]+\s*&&\s*!\s*state\.pathTask/,
		];
		expect(
			gateShapes.some((shape) => shape.test(gate)),
			'"loading..." must be gated on both the tree node and state.pathTask being absent'
		).toBe(true);
	});

	// ---- 4. /api/path 失败不压制 ancestorIds 回退 ---------------------------

	it("should keep state.pathFor untouched in the ensurePath catch branch", () => {
		// Arrange: ensurePath 函数体 + catch 块
		const body = fnBody("ensurePath");
		const catchIdx = body.search(/catch\s*\([^)]*\)\s*\{/);
		expect(catchIdx, "missing ensurePath catch handler").toBeGreaterThan(-1);
		const catchBlock = blockAt(body, catchIdx);

		// Assert: 失败分支不得写 state.pathFor（应保持 null）—— 否则
		// pathFor === taskId 成立，renderCrumbs/goBack 的 ancestorIds 回退
		// 被伪造的归属压制（审阅确认的缺陷）
		expect(catchBlock, "the /api/path failure branch must not write state.pathFor").not.toMatch(/state\.pathFor\s*=(?!=)/);
	});

	it("should fall back to ancestorIds in goBack when state.pathFor is not the current task", () => {
		// Arrange: goBack 函数体（回归锁，当前应绿）
		const body = fnBody("goBack");

		// Assert: pathFor 不归属本任务时取 ancestorIds 回退 —— 三元等价形状
		// （=== ? state.path : ancestorIds）或 !== 分支形状任一
		const fallbackShapes = [
			/state\.pathFor\s*===\s*state\.taskId\s*\?\s*state\.path\s*:\s*ancestorIds\(/,
			/state\.taskId\s*===\s*state\.pathFor\s*\?\s*state\.path\s*:\s*ancestorIds\(/,
			/state\.pathFor\s*(?:!==|!=)\s*state\.taskId[^;]{0,250}?ancestorIds\(/,
			/state\.taskId\s*(?:!==|!=)\s*state\.pathFor[^;]{0,250}?ancestorIds\(/,
		];
		expect(
			fallbackShapes.some((shape) => shape.test(body)),
			"goBack must fall back to ancestorIds when state.pathFor is not this task"
		).toBe(true);
	});

	// ---- 5. 路由竞态守卫（回归锁，当前应绿）--------------------------------

	it("should discard stale /api/path responses in both the success and failure handlers via state.taskId !== taskId", () => {
		// Arrange: ensurePath 函数体 + catch 块
		const body = fnBody("ensurePath");

		// Assert: 成功与失败两个 handler 各一处过期响应丢弃（≥2 处）
		const guards = body.match(/state\.taskId\s*(?:!==|!=)\s*taskId/g) ?? [];
		expect(guards.length, "both ensurePath handlers must discard stale responses").toBeGreaterThanOrEqual(2);

		// Assert: catch 块内的丢弃必须是提前 return（非事后补写）
		const catchIdx = body.search(/catch\s*\([^)]*\)\s*\{/);
		expect(catchIdx, "missing ensurePath catch handler").toBeGreaterThan(-1);
		const catchBlock = blockAt(body, catchIdx);
		expect(catchBlock, "the ensurePath failure handler must early-return on a stale response").toMatch(
			/state\.taskId\s*(?:!==|!=)\s*taskId[\s\S]{0,120}?\breturn\b/
		);
	});

	// ---- 5b. A→B→A 竞态守卫（回归锁，当前应绿）-----------------------------

	it("should discard stale pollOnce/backfillOlder responses via state.gen !== gen || state.taskId !== taskId", () => {
		// Arrange: 两个轮询函数体 —— A→B→A 后 taskId 再次相等，仅靠 taskId
		// 挡不住过期响应，必须同时比对捕获的 gen（generation）
		const pollBody = fnBody("pollOnce");
		const backfillBody = fnBody("backfillOlder");

		// Assert: 发请求前各自捕获 gen 与 taskId
		for (const [name, body] of [
			["pollOnce", pollBody],
			["backfillOlder", backfillBody],
		] as const) {
			expect(body, `${name} must capture the generation before requesting`).toMatch(/gen\s*=\s*state\.gen/);
			expect(body, `${name} must capture the task id before requesting`).toMatch(/taskId\s*=\s*state\.taskId/);
		}

		// Assert: 响应回调（成功/失败路径）里用 state.gen !== gen ||
		// state.taskId !== taskId 丢弃过期响应，两函数合计 ≥2 处
		const guard = /state\.gen\s*(?:!==|!=)\s*gen\s*\|\|\s*state\.taskId\s*(?:!==|!=)\s*taskId/g;
		const hits = (pollBody.match(guard) ?? []).length + (backfillBody.match(guard) ?? []).length;
		expect(hits, "pollOnce and backfillOlder must each discard stale responses on gen/taskId mismatch").toBeGreaterThanOrEqual(2);
		expect((pollBody.match(guard) ?? []).length, "pollOnce must guard its response callbacks").toBeGreaterThanOrEqual(1);
		expect((backfillBody.match(guard) ?? []).length, "backfillOlder must guard its response callbacks").toBeGreaterThanOrEqual(1);
	});

	// ---- 6. found 生产端判定（回归锁，当前应绿）----------------------------

	it("should derive state.pathFound from the response's found field instead of hard-coding it", () => {
		// Arrange: ensurePath 函数体
		const body = fnBody("ensurePath");

		// Assert: 赋值右侧引用 found 字段（result.found / 响应变量.found），
		// 且不得硬编码 true/false
		expect(body, "state.pathFound must be derived from the response's found field").toMatch(
			/state\.pathFound\s*=\s*[^;\n]*\bfound\b/
		);
		expect(body, "state.pathFound must not be hard-coded").not.toMatch(/state\.pathFound\s*=\s*(?:true|false)\b/);
	});

	// ---- 7. .child-summary 默认省略号（任何宽度不横向溢出）-----------------

	it("should give the default .child-summary rule the full ellipsis set so it never overflows horizontally at any width", () => {
		// Arrange: 剔除 @container 块后的默认样式表 —— 容器查询里的同名规则
		// 优先命中 match()，不剔除会误把块内规则当默认规则
		const style = pageStyle().replace(/@container[\s\S]*?\}\s*\}/g, "");
		const rule = style.match(/\.child-summary\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: 默认规则即带四件套 —— min-width:0（可压缩）+ overflow:hidden +
		// text-overflow:ellipsis + white-space:nowrap（永不折行、永不横向溢出）
		expect(rule, "missing default .child-summary rule").not.toBe("");
		expect(rule, ".child-summary default must set min-width: 0").toMatch(/min-width:\s*0/);
		expect(rule, ".child-summary default must set overflow: hidden").toMatch(/overflow:\s*hidden/);
		expect(rule, ".child-summary default must set text-overflow: ellipsis").toMatch(/text-overflow:\s*ellipsis/);
		expect(rule, ".child-summary default must set white-space: nowrap").toMatch(/white-space:\s*nowrap/);
	});

	// ---- 8. not-found 单一 aria-current + 药丸无尾部竖线 --------------------

	it("should render aria-current=page on exactly one crumb when the task is not found (the not-found crumb IS the current crumb)", () => {
		// Arrange: renderCrumbs 函数体 + crumb-not-found 追加点
		const body = fnBody("renderCrumbs");
		const idx = body.indexOf("crumb-not-found");
		expect(idx, "missing crumb-not-found in renderCrumbs").toBeGreaterThan(-1);
		const after = body.slice(idx, idx + 700);

		// Assert: not-found 分支与常规当前节互斥 —— 追加 not-found 节后提前
		// return、常规当前节落 else 分支、常规当前节的 aria-current 受
		// pathFound !== false 门控、或 not-found 类直接加在当前节上（不再有
		// 第二个 aria-current），四种合法形状任一；两个 aria-current="page"
		// 同时可达（现状）不满足任何形状
		const exclusiveShapes = [
			/\breturn\b/.test(after),
			/\}\s*else\s*\{/.test(after),
			/state\.pathFound\s*(?:!==|!=)\s*false[\s\S]{0,400}?setAttribute\(\s*"aria-current"/.test(body),
			/classList\.add\(\s*"crumb-not-found"\s*\)/.test(body),
		];
		expect(
			exclusiveShapes.some(Boolean),
			"not-found crumb and the current crumb must not both carry aria-current=page"
		).toBe(true);
	});

	it("should not leave a trailing ' | ' on the status pill when the meta carries no startedAt", () => {
		// Arrange: updateStatusPill 函数体
		const body = fnBody("updateStatusPill");

		// Assert: 时长分隔符必须以 startedAt 为门控（pathTask 无 startedAt 时
		// 文本为裸状态名，无尾部 " | "）
		expect(body, "pill text composition must gate the duration on startedAt").toMatch(/startedAt/);

		// Assert: 禁止旧形状 —— 无条件 " | " + (x ? formatDuration(x) : "")，
		// 空时长时尾部竖线裸露（审阅确认的缺陷）
		expect(body, 'pill text must not concatenate an unconditional " | " with an empty-duration fallback').not.toMatch(
			/"\s*\|\s*"\s*\+\s*\(\s*[\w.]+\s*\?\s*formatDuration\([^)]*\)\s*:\s*""\s*\)/
		);
	});
});

// ---------------------------------------------------------------------------
// 本轮 A：外链图片不得发起任何请求（字符串级中和 + DOM 双选择器，红阶段）。
// 冻结契约：
//   A1. 同源内联：PAGE_HTML 含 neutralizeRemoteMarkup.toString() 完整源码
//       （真值用例见 test/subagent-web-markdown.test.ts 的
//       neutralizeRemoteMarkup 组），且存在内联定义之外的调用点；
//   A2. 渲染入口：wrap.innerHTML = neutralizeRemoteMarkup(marked.parse(escapeRawHtml(…)))
//       —— marked.parse 产物先经整串中和才进 innerHTML；
//   A3. DOM sanitizer 消费 img[src], img[data-remote-src] 双选择器，remote 占位
//       用 data-remote-src 的原值构造 .remote-image。
// 实现由 coder 落地；本组在 src/web/ 未改时全部预期红。
// ---------------------------------------------------------------------------

/** 动态取出 neutralizeRemoteMarkup；缺失时先报明确失败再红。 */
async function loadNeutralizeRemoteMarkup(): Promise<(html: unknown) => string> {
	const mod = (await import("../src/web/markdown.ts")) as unknown as Record<string, unknown>;
	expect(typeof mod.neutralizeRemoteMarkup, "markdown.ts must export neutralizeRemoteMarkup(html: string): string").toBe("function");
	return mod.neutralizeRemoteMarkup as (html: unknown) => string;
}

describe("PAGE_HTML 外链图片字符串级中和（A，红阶段，字符串级）", () => {
	it("should inline the complete neutralizeRemoteMarkup function source so page and module stay in sync", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act / Assert: 与 escapeRawHtml/isSafeHref/isAllowedImageSrc 同模式 ——
		// 完整源码文本逐字在页面内（删除 ${…toString()} 插值即红）
		expect(PAGE_HTML).toContain(neutralizeRemoteMarkup.toString());
	});

	it("should call neutralizeRemoteMarkup( at a rendering call site outside the inlined definition", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 内联定义本身是 `function neutralizeRemoteMarkup(`，负向后视排除，
		// 只认真正的调用点（renderMarkdown 里对 marked.parse 产物的整串中和）
		expect(PAGE_HTML).toMatch(/(?<!function )neutralizeRemoteMarkup\(/);
	});

	it("should wrap the marked.parse(escapeRawHtml( output in neutralizeRemoteMarkup( before assigning it to wrap.innerHTML", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 渲染入口逐字 —— innerHTML 赋值右侧 = 中和包裹的 marked.parse 产物，
		// 中和必须发生在赋值（进入 DOM）之前
		expect(PAGE_HTML).toMatch(/wrap\.innerHTML\s*=\s*neutralizeRemoteMarkup\(marked\.parse\(escapeRawHtml\(/);
	});

	it("should make the DOM sanitizer consume img[src], img[data-remote-src] and read the remote URL from data-remote-src", () => {
		// Arrange: renderMarkdown 函数体
		const body = fnBody("renderMarkdown");

		// Assert: 双选择器逐字 —— src 已中和的 img 与 data-remote-src 占位
		// 一并消费（字符串级中和后 DOM 侧不再依赖 isAllowedImageSrc 区分远近）
		expect(body).toMatch(/querySelectorAll\(\s*["']img\[src\],\s*img\[data-remote-src\]["']\s*\)/);

		// Assert: remote 占位用 data-remote-src 的原值构造 .remote-image
		expect(body).toMatch(/getAttribute\(\s*["']data-remote-src["']\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// 本轮 B：light recent 圆点对比度 ≥3:1（红阶段，WCAG 计算锁定，不锁字面值）。
// 冻结契约：light :root 的 --st-recent-dot 与 light --panel（#ffffff）的 WCAG
// 对比度 ≥3；dark 块 --st-recent-dot: #e3b341; 不得改动。原 #d9a032 对白底
// 仅 2.33，本组用例在重新配色前预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML light recent 圆点对比度（B，红阶段，WCAG 计算）", () => {
	/** WCAG 2.x 相对亮度：sRGB 通道线性化后加权。 */
	function relativeLuminance(hex: string): number {
		const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
		expect(match, `not a hex colour: ${hex}`).not.toBeNull();
		let full = (match as RegExpExecArray)[1];
		if (full.length === 3) {
			full = full
				.split("")
				.map((c) => c + c)
				.join("");
		}
		const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
		const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
		return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
	}

	/** WCAG 对比度 = (L_light + 0.05) / (L_dark + 0.05)。 */
	function contrastRatio(a: string, b: string): number {
		const la = relativeLuminance(a);
		const lb = relativeLuminance(b);
		const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
		return (hi + 0.05) / (lo + 0.05);
	}

	/** 从亮色 :root（首个 :root 规则块）解析十六进制设计令牌值。 */
	function lightRootToken(name: string): string {
		const root = pageStyle().match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
		expect(root, "missing light :root block").not.toBe("");
		const match = root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
		expect(match, `missing light :root token ${name}`).not.toBeNull();
		return (match as RegExpExecArray)[1];
	}

	it("should give the light recent dot at least 3:1 contrast against the light panel", () => {
		// Arrange: 从 PAGE_HTML 解析 light 令牌（不锁字面值，配色可再调）
		const dot = lightRootToken("--st-recent-dot");
		const panel = lightRootToken("--panel");

		// Act: WCAG 对比度
		const ratio = contrastRatio(dot, panel);

		// Assert: 圆点是图形组件（非文字），需 ≥3:1（WCAG 1.4.11）；
		// 原值 #d9a032 对 #ffffff 仅 2.33 —— 本断言在重新配色前红
		expect(ratio, `light --st-recent-dot ${dot} vs --panel ${panel} contrast ${ratio.toFixed(2)} must be >= 3`).toBeGreaterThanOrEqual(3);
	});

	it("should keep the dark recent dot at the exact #e3b341 (no dark-scheme regression)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 暗色块 recent 圆点逐字不变 —— 防止修亮色时误伤暗色配色
		//（暗色 #e3b341 对 #161b22 底本就达标，不需改动）
		expect(PAGE_HTML).toMatch(/--st-recent-dot:\s*#e3b341\s*;/);
	});
});

// ---------------------------------------------------------------------------
// 本轮 C：树行 aria-label（红阶段，字符串级）。冻结契约：renderList 的 .node
// 行设置 aria-label，内容形如 <agent> · <status> · <duration>（由
// node.agent / node.status / formatDuration(node) 拼接，" · " 分隔），
// 可见文本节点不变（aria-label 只是辅助技术补充）。
// 实现由 coder 落地；本组在 src/web/ 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 树行 aria-label（C，红阶段，字符串级）", () => {
	it("should set an aria-label on the .node row composing agent, status and duration with the ' · ' separator", () => {
		// Arrange: 行渲染函数体
		const body = renderListBody();

		// Act: 行上 aria-label 写入点及其后的内容拼接窗口（一条 setAttribute
		// 语句 + 合理余量）
		const labelIdx = body.search(/row\.setAttribute\(\s*["']aria-label["']/);
		expect(labelIdx, "renderList must set aria-label on the .node row").toBeGreaterThan(-1);
		const labelWin = body.slice(labelIdx, labelIdx + 400);

		// Assert: 分隔符逐字 " · "（U+00B7 中点两侧空格）+ 三段数据源齐全
		expect(labelWin).toContain('" · "');
		expect(labelWin).toMatch(/node\.agent/);
		expect(labelWin).toMatch(/node\.status/);
		expect(labelWin).toMatch(/formatDuration\(\s*node\s*\)/);

		// Assert: 拼接顺序 = <agent> · <status> · <duration>
		expect(labelWin.indexOf("node.agent")).toBeLessThan(labelWin.indexOf("node.status"));
		expect(labelWin.indexOf("node.status")).toBeLessThan(labelWin.indexOf("formatDuration("));
	});

	it("should keep the visible row text nodes unchanged when adding the aria-label", () => {
		// Arrange: 行创建块（.node 行创建 → item.appendChild(row)）
		const body = renderListBody();
		const rowAt = body.indexOf('el("div", "node"');
		expect(rowAt, "missing .node row creation").toBeGreaterThan(-1);
		const rowEnd = body.indexOf("item.appendChild(row)", rowAt);
		expect(rowEnd, "missing item.appendChild(row)").toBeGreaterThan(rowAt);
		const rowBlock = body.slice(rowAt, rowEnd);

		// Assert: 可见文本元素与取值不变 —— aria-label 是属性补充，不得改写/
		// 移除既有可见文本节点（状态词、徽章 agent 名、耗时）
		expect(rowBlock).toMatch(/el\(\s*"span"\s*,\s*"status-word"\s*,\s*node\.status/);
		expect(rowBlock).toMatch(/el\(\s*"span"\s*,\s*"badge"\s*,\s*node\.agent/);
		expect(rowBlock).toMatch(/el\(\s*"span"\s*,\s*"elapsed"\s*,\s*formatDuration\(\s*node\s*\)/);
		expect(rowBlock).not.toMatch(/row\.textContent\s*=/);
	});
});

// ---------------------------------------------------------------------------
// 本轮 A：侧栏行内徽章不折行不溢出（红阶段，CSS 契约）。冻结契约：
//   A1. .badge 规则同时带 white-space: nowrap + overflow: hidden +
//       text-overflow: ellipsis（长 agent 名在 32px 单行内被省略截断，
//       不折行、不溢出徽章）；
//   A2. .status-word / .tid / .elapsed 三条规则各自带 white-space: nowrap
//       （.elapsed 文本形如 "1m 41s" 含空格，不 nowrap 会在空格处折行）；
//   A3. .child-summary 既有 nowrap（已有用例锁定，本组补回归断言）；
//   A4. 回归锚点（当前应绿）：基础 .badge 规则带 max-width: 14em（省略号
//       不再是死声明）；
//   A5. 回归锚点（当前应绿）：@container (max-width: 340px) 块内 .badge
//       收紧 max-width: 9.2em，且基础 14em 规则先于该块（覆盖顺序锁定）。
// 三档宽度（320/480/700px）的真实行高读数不在本文件做，由后续浏览器验证；
// 此处只锁 CSS 契约。实现由 coder 落地；本组在 src/web/page.ts 未改时预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 侧栏行内徽章不折行不溢出（A，红阶段，CSS 契约）", () => {
	it("should give .badge the nowrap/hidden/ellipsis set so a long agent name never wraps or spills", () => {
		// Arrange: .badge 规则声明体
		const rule = pageStyle().match(/\.badge\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: 三件套缺一不可 —— 折行（nowrap）、溢出裁剪（hidden）、
		// 超出显示省略号（ellipsis）
		expect(rule, "missing .badge rule").not.toBe("");
		expect(rule, ".badge must set white-space: nowrap").toMatch(/white-space:\s*nowrap/);
		expect(rule, ".badge must set overflow: hidden").toMatch(/overflow:\s*hidden/);
		expect(rule, ".badge must set text-overflow: ellipsis").toMatch(/text-overflow:\s*ellipsis/);
	});

	it("should keep .status-word on a single line with white-space: nowrap", () => {
		// Arrange / Act: 页面样式表

		// Assert: 状态词在 32px 行内不折行（含组合选择器写法宽容）
		expect(pageStyle()).toMatch(/\.status-word[^{}]*\{[^}]*white-space:\s*nowrap/);
	});

	it("should keep .tid on a single line with white-space: nowrap", () => {
		// Arrange / Act: 页面样式表

		// Assert: taskId 短码不折行（@container 降级块内的同名规则不带
		// nowrap，正则会继续匹配到默认规则）
		expect(pageStyle()).toMatch(/\.tid[^{}]*\{[^}]*white-space:\s*nowrap/);
	});

	it("should keep .elapsed on a single line with white-space: nowrap (duration text like '1m 41s' contains a space)", () => {
		// Arrange / Act: 页面样式表

		// Assert: 耗时文本含空格，不 nowrap 会在空格处折行撑破 32px 行
		expect(pageStyle()).toMatch(/\.elapsed[^{}]*\{[^}]*white-space:\s*nowrap/);
	});

	it("should keep the default .child-summary rule on a single line with white-space: nowrap (regression)", () => {
		// Arrange: 剔除 @container 块后的默认样式表（同既有 .child-summary 用例）
		const style = pageStyle().replace(/@container[\s\S]*?\}\s*\}/g, "");
		const rule = style.match(/\.child-summary\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: 既有 nowrap 契约保留（当前应绿的回归锚点）
		expect(rule, "missing default .child-summary rule").not.toBe("");
		expect(rule, ".child-summary default must keep white-space: nowrap").toMatch(/white-space:\s*nowrap/);
	});

	it("should cap .badge width so text-overflow:ellipsis is live", () => {
		// Arrange: 基础 .badge 规则声明体（首个 .badge { … } 即基础规则，
		// 340px 容器块内的收紧规则出现在其后）
		const rule = pageStyle().match(/\.badge\s*\{([^}]*)\}/)?.[1] ?? "";

		// Assert: max-width 给 overflow:hidden/text-overflow:ellipsis 一个可裁
		// 剪的边界 —— 没有宽度上限，长 agent 名会撑满 flex 可用宽度，省略号
		// 成死声明（回归锚点：删除 max-width: 14em 即红）
		expect(rule, "missing .badge rule").not.toBe("");
		expect(rule, ".badge must cap its width so the ellipsis is live").toMatch(/max-width\s*:\s*14em/);
	});

	it("should tighten the badge cap inside the narrow-container degrade block", () => {
		// Arrange: 全文样式表（含注释与全部 @container 块）
		const style = pageStyle();
		const containerIdx = style.search(/@container\s*\(max-width:\s*340px\)/);
		expect(containerIdx, "missing @container (max-width: 340px) degrade block").toBeGreaterThan(-1);
		const block = style.slice(containerIdx, containerIdx + 400);

		// Assert: 340px 窄容器块内 .badge 收紧 max-width: 9.2em（降级不溢出）
		expect(block, "the 340px block must tighten .badge max-width to 9.2em").toMatch(
			/\.badge\s*\{[^}]*max-width\s*:\s*9\.2em/
		);

		// Assert: 基础 14em 上限先于 340px 块出现 —— 锁定覆盖顺序（同特异性
		// 下后写的容器规则才能压过基础规则；注：裸 "340px" 会先命中降级顺序
		// 注释，故以 @container 块字面定位）
		const baseIdx = style.indexOf("max-width: 14em");
		expect(baseIdx, "missing base max-width: 14em cap").toBeGreaterThan(-1);
		expect(baseIdx, "the base 14em cap must precede the 340px container override").toBeLessThan(containerIdx);
	});
});

// ---------------------------------------------------------------------------
// 本轮 C：← Back 仅 depth ≥ 2（祖先链非空）出现（红阶段，字符串级 + 单测
// 联动）。冻结契约：
//   C1. src/web/tree-view.ts 新导出 backTarget(path, ancestors)，页面以
//       ${backTarget.toString()} 内联 —— PAGE_HTML 含 function backTarget(；
//       真值用例见 test/subagent-web-tree-view.test.ts；
//   C2. renderCrumbs() 内 ← Back 按钮的插入位于「祖先链非空」守卫块内
//       （backTarget(...) 出现在 if 条件或其 null 检查的前置 var 中，
//       按钮创建位于该 if 的块内）；
//   C3. goBack() 祖先链为空（depth ≤1）时提前 return、不写 location.hash
//       —— if（null/空判定）后紧跟 return，location.hash 赋值在其后；
//       按裁决 2，对应用例并入 B 组「should make goBack() leave location.hash
//       untouched when the ancestor chain is empty」，本组不重复收录。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML ← Back 仅 depth ≥ 2（C，红阶段，字符串级）", () => {
	it("should inline the backTarget helper source into the page", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 内联声明字面存在（同 crumbLabel 的 ${…toString()} 模式）
		expect(PAGE_HTML).toContain("function backTarget(");

		// Assert: 同源守卫 —— 模块导出与页面内联同一份源码；导出缺失时先
		// 以明确信息报红（而非 TypeError）
		expect(typeof backTarget, "src/web/tree-view.ts must export backTarget(path, ancestors): string | null").toBe("function");
		expect(PAGE_HTML).toContain(backTarget.toString());
	});

	it("should gate the ← Back insertion in renderCrumbs() on a non-empty ancestor chain", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 先定位 backTarget 调用（缺失即红 —— 守卫无从谈起）
		const callIdx = body.search(/backTarget\(/);
		expect(callIdx, "renderCrumbs must compute the back target via backTarget(").toBeGreaterThan(-1);

		// Act: 从 backTarget 调用起找祖先链非空守卫（backTarget 条件内联、
		// var back = backTarget(...); if (back !== null) 或 if (!back) 等形状）
		const guard = findGuardedIf(body, callIdx, /backTarget\s*\(|!==?\s*null|!\s*[A-Za-z_$][\w$]*/);
		expect(guard, "the Back button insertion must sit inside an ancestor-chain guard").not.toBeNull();

		// Assert: ← Back 按钮的创建位于守卫块内（主块或 else 块任一）
		const guardHit = guard as NonNullable<typeof guard>;
		const guarded = guardHit.block + (guardHit.elseBlock ?? "");
		expect(guarded, "Back button must be created inside the ancestor-chain guard block").toMatch(/← Back|back-btn/);
	});
});

// ---------------------------------------------------------------------------
// 本轮 E：正文来源链接新标签页打开（红阶段，字符串级）。冻结契约：
//   E1. renderMarkdown 的 a[href] 处理段：通过 isSafeHref 的 http(s) href
//       设 target="_blank" 且 rel 含 noopener；target 赋值位于 http(s)
//       判断分支内（页内 # 锚点不设 target）；
//   E2. isSafeHref 白名单仍在 target/rel 写入之前（白名单不丢）；
//   E3. 远端图片占位锚点保持 target="_blank" + rel="noopener noreferrer"
//       （F 组既有用例锁定，本组保留不改）；
//   E4. 内部导航项（subagent nav → open 锚点、面包屑 #/t/... 链节）不得带
//       target（nav 锚点由既有用例锁定，本组补面包屑断言）；
//   E5. _blank 守卫放行规则 =「每处 _blank ±300 字符窗口内含 noopener」，
//       正文链接同走这条放行规则（守卫用例已同步改注释/名，不断言变化）。
// 实现由 coder 落地；本组 E1 相关断言在 src/web/page.ts 未改时预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 正文来源链接新标签页打开（E，红阶段，字符串级）", () => {
	it("should mark safe body links with target=\"_blank\" alongside a noopener rel inside renderMarkdown", () => {
		// Arrange: renderMarkdown 的 a[href] 处理段
		const region = markdownAnchorRegion();

		// Assert: noopener rel 既有（当前应绿）
		expect(region, "body links must carry a noopener rel").toContain("noopener");

		// Assert（本轮新增，当前应红）: 正文链接被授予 target="_blank"
		//（.target = 赋值或 setAttribute 两种写法任一）
		expect(
			region,
			"safe body links must open in a new tab via target=\"_blank\""
		).toMatch(/\.target\s*=\s*"_blank"|setAttribute\(\s*["']target["']\s*,\s*"_blank"\s*\)/);
	});

	it("should gate the new-tab target behind an http(s) check so page-internal # anchors stay in-page", () => {
		// Arrange: renderMarkdown 的 a[href] 处理段
		const region = markdownAnchorRegion();
		const targetIdx = region.search(/\.target\s*=|setAttribute\(\s*["']target["']/);
		expect(targetIdx, "missing target assignment in the body-link region").toBeGreaterThan(-1);

		// Act: target 赋值之前的处理前缀
		const head = region.slice(0, targetIdx);

		// Assert: 白名单先于 target（whitelist 不丢、且在新标签判定之前）
		expect(head, "the isSafeHref whitelist must run before the target assignment").toMatch(/isSafeHref\(/);

		// Assert: http(s) 正向判断分支内才设 target —— 页内 # 锚点不设 target
		expect(head, "the target assignment must sit inside an http(s) branch").toMatch(/https?/i);
	});

	it("should keep body links behind the isSafeHref whitelist (whitelist not dropped)", () => {
		// Arrange: renderMarkdown 的 a[href] 处理段
		const region = markdownAnchorRegion();

		// Assert: 不安全 href 仍被白名单拒绝并降级为纯文本（既有语义保留）
		expect(region).toMatch(/if\s*\(\s*!\s*isSafeHref\(\s*href\s*\)\s*\)/);
		expect(region).toMatch(/replaceChild\(|textContent/);

		// Assert: rel/target 等链接加工都排在白名单判断之后
		const guardIdx = region.indexOf("isSafeHref(");
		const relIdx = region.indexOf('setAttribute("rel"');
		expect(guardIdx, "missing isSafeHref guard in the body-link region").toBeGreaterThan(-1);
		expect(relIdx, "rel must only be written after the whitelist check").toBeGreaterThan(guardIdx);
	});

	it("should keep breadcrumb ancestor links (#/t/...) target-free", () => {
		// Arrange: renderCrumbs 函数体
		const body = fnBody("renderCrumbs");

		// Assert: 面包屑链节（祖先段/当前段）是同页哈希导航 —— 不得带
		// target 赋值，也不得出现 _blank（内部导航不开新标签）
		expect(body).not.toMatch(/\.target\s*=|setAttribute\(\s*["']target["']/);
		expect(body).not.toContain("_blank");
	});
});

// ---------------------------------------------------------------------------
// 本轮 D：.elapsed 极端耗时溢出兜底（红阶段，CSS 契约）。冻结契约：
//   .elapsed 规则新增宽度上限与省略号 —— 至少含 max-width 且 overflow: hidden /
//   text-overflow: ellipsis（极端耗时长文本如 "999m 59s" 被省略号截断，
//   不撑破 32px 单行）；既有 white-space: nowrap 与 flex-shrink: 0 保留，
//   由既有用例锁定（本组不重复收录）。
// 实现由 coder 落地；本组在 src/web/page.ts 未改时预期红。
// ---------------------------------------------------------------------------

describe("PAGE_HTML .elapsed 极端耗时溢出兜底（D，红阶段，CSS 契约）", () => {
	it("should cap the .elapsed width with max-width plus overflow: hidden and text-overflow: ellipsis", () => {
		// Arrange: 全部 .elapsed 规则声明体（@container 降级块内的
		// .elapsed { display: none; } 出现在基础规则之前，不能只取首条）
		const bodies = [...pageStyle().matchAll(/\.elapsed\s*\{([^}]*)\}/g)].map((m) => m[1]);
		const capped = bodies.some((body) =>
			/max-width\s*:/.test(body) && /overflow\s*:\s*hidden/.test(body) && /text-overflow\s*:\s*ellipsis/.test(body)
		);

		// Assert（本轮 D，当前应红）: 某条 .elapsed 规则同时带宽度上限 + 溢出
		// 裁剪 + 省略号 —— 缺 max-width 时 text-overflow 会成死声明
		expect(bodies.length, "missing .elapsed rules").toBeGreaterThan(0);
		expect(capped, ".elapsed must carry max-width + overflow: hidden + text-overflow: ellipsis").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 本轮 A：深任务谱系高亮（红阶段，字符串级）。冻结契约见文件头 A1–A6：
//   侧栏只列 depth-1 任务；当前任务 depth ≥ 2 时把其 depth-1 祖先行置为选中态
//   （复用 active + aria-current="true"，全局唯一），并在该行尾部加位置后缀
//   "↳ <当前 agent> · <当前 taskId 前 8 位>"；depth 1 无后缀；祖先行不在已加载
//   列表（被截断）时不得误高亮别的行 —— 无 rowId 匹配即高亮 0 行。
// 实现由 coder 落地；A1–A5 在 src 未改时预期红，A6 回归锁当前即绿。
// A5 CSS 浏览器实测两轮修订（最终定稿，只改测试不改 src）：.lineage 采用
//   「可收缩但有区间钳制」—— flex: 0 1 auto + min-width: 6em（无下限时曾被压到
//   ~0.6px 不可读）+ max-width: 9em（固定不收缩的 0 0 auto 又会挤掉相邻列）；
//   @container (max-width: 340px) 内 .node:has(.lineage) .tid/.elapsed/
//   .child-summary 让位规则保留（badge 已恢复完整、不再收缩）；对应用例仍拆为
//   基础规则与让位规则两条。
// ---------------------------------------------------------------------------

/** 从 `(` 起平衡括号抽取调用实参文本（供 lineageRowId/lineageLabel 实参形状断言）。 */
function callArgs(body: string, parenIdx: number): string {
	expect(body[parenIdx], "expected '(' at the given index").toBe("(");
	let depth = 0;
	for (let i = parenIdx; i < body.length; i += 1) {
		if (body[i] === "(") depth += 1;
		else if (body[i] === ")") {
			depth -= 1;
			if (depth === 0) return body.slice(parenIdx + 1, i);
		}
	}
	throw new Error("unbalanced call parens after index " + parenIdx);
}

describe("PAGE_HTML 深任务谱系高亮（A，红阶段，字符串级）", () => {
	it("should inline the function lineageRowId( and function lineageLabel( sources into PAGE_HTML", async () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert（A1）: 两个新 helper 的声明字面在页面脚本内（${…toString()} 插值）
		expect(PAGE_HTML).toContain("function lineageRowId(");
		expect(PAGE_HTML).toContain("function lineageLabel(");

		// Assert: 同源守卫 —— 模块导出缺失时先以明确信息报红（而非 TypeError），
		// 导出后要求页面内联源码与模块导出逐字一致
		const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
		for (const name of ["lineageRowId", "lineageLabel"]) {
			const fn = mod[name];
			if (typeof fn !== "function") {
				throw new Error(`${name} 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）`);
			}
			expect(PAGE_HTML).toContain(fn.toString());
		}
	});

	it("should compute the highlighted row through lineageRowId(...) and match rows with rows[i].dataset.taskId === rowId", () => {
		// Arrange: highlightSelection 函数体
		const body = fnBody("highlightSelection");

		// Assert（A2）: rowId 由 lineageRowId( 求得（缺失即红 —— 高亮目标不再
		// 是当前 taskId，而是 depth-1 祖先行）
		const callIdx = body.search(/lineageRowId\s*\(/);
		expect(callIdx, "highlightSelection must compute the target row via lineageRowId(").toBeGreaterThan(-1);

		// Act: 平衡括号抽出调用实参
		const args = callArgs(body, body.indexOf("(", callIdx));

		// Assert: 三实参形状 —— 当前任务 id、仅当 path 归属本任务时取 state.path
		// （否则空数组，交给 ancestors 回退）、树内祖先链兜底
		expect(args, "lineageRowId must receive state.taskId").toMatch(/\bstate\.taskId\b/);
		expect(
			args,
			"lineageRowId must receive state.pathFor === state.taskId ? state.path : []"
		).toMatch(
			/state\.pathFor\s*===\s*state\.taskId\s*\?\s*state\.path\s*:\s*\[\s*\]|state\.taskId\s*===\s*state\.pathFor\s*\?\s*state\.path\s*:\s*\[\s*\]/
		);
		expect(args, "lineageRowId must fall back to ancestorIds(state.tree, state.taskId)").toMatch(
			/ancestorIds\(\s*state\.tree\s*,\s*state\.taskId\s*\)/
		);

		// Assert: 唯一选中判据 = dataset.taskId 与 rowId 比较 —— 祖先行不在已
		// 加载列表（截断）时没有任何行匹配 → 0 行高亮；不得回退成与
		// state.taskId 直接比较（那会误高亮别的行）
		expect(body, "rows must be matched by rows[i].dataset.taskId === rowId").toMatch(
			/rows\[i\]\.dataset\.taskId\s*===\s*rowId/
		);
		expect(body, "must not fall back to matching rows by state.taskId").not.toMatch(
			/rows\[i\]\.dataset\.taskId\s*===\s*state\.taskId/
		);

		// Assert: 全局唯一 —— 未匹配行同时移除 active 与 aria-current（既有
		// 写法，回归锁）
		expect(body).toMatch(/classList\.toggle\(\s*"active"/);
		expect(body).toMatch(/removeAttribute\(\s*"aria-current"\s*\)/);
	});

	it('should append a "lineage" suffix span built by lineageLabel(...) to the selected row only when rowId !== state.taskId', () => {
		// Arrange: highlightSelection 函数体
		const body = fnBody("highlightSelection");

		// Assert（A3）: depth ≥ 2 守卫 —— rowId !== state.taskId 比较存在
		const guardIdx = body.search(/rowId\s*!==\s*state\.taskId|state\.taskId\s*!==\s*rowId/);
		expect(guardIdx, "the suffix must be gated on rowId !== state.taskId (depth ≥ 2)").toBeGreaterThan(-1);

		// Assert: <span class="lineage"> 创建（el("span","lineage",…) 或
		// createElement("span") + class 两种形状任一）
		const createIdx = body.search(
			/el\(\s*"span"\s*,\s*"lineage"|createElement\(\s*"span"\s*\)[\s\S]{0,240}["']lineage["']/
		);
		expect(createIdx, 'missing <span class="lineage"> creation in highlightSelection').toBeGreaterThan(-1);
		expect(createIdx, "the suffix span must be created inside the depth ≥ 2 guard").toBeGreaterThan(guardIdx);

		// Assert: 后缀文本由 lineageLabel( 生成，实参带当前节点 agent 与当前
		// taskId（当前节点取 state.pathTask || findNode(state.tree, state.taskId)）
		const labelIdx = body.search(/lineageLabel\s*\(/);
		expect(labelIdx, "the suffix text must come from lineageLabel(").toBeGreaterThan(-1);
		const args = callArgs(body, body.indexOf("(", labelIdx));
		expect(args, "lineageLabel must receive the current taskId").toMatch(/\bstate\.taskId\b/);
		expect(
			args,
			"lineageLabel must receive the current node's agent (state.pathTask || findNode(state.tree, state.taskId))"
		).toMatch(/state\.pathTask\s*\|\||findNode\(\s*state\.tree\s*,\s*state\.taskId\s*\)/);
		expect(labelIdx, "the suffix must be built inside the depth ≥ 2 guard").toBeGreaterThan(guardIdx);

		// Assert: 后缀挂到选中行尾部（创建后紧跟 append/appendChild）
		const appendIdx = body.indexOf(".append", createIdx);
		expect(appendIdx, "the suffix span must be appended to the selected row").toBeGreaterThan(createIdx);
		expect(appendIdx - createIdx, "creation and append must sit close together").toBeLessThan(500);

		// Assert: depth 1（rowId === state.taskId）时移除该行既有 .lineage ——
		// 后缀不得在顶层任务上残留
		const removalShapes = [
			/querySelector(?:All)?\(\s*["']\.lineage["']\s*\)[\s\S]{0,400}(?:\.remove\(\)|\.removeChild\(|\.parentNode)/,
			/classList\.contains\(\s*"lineage"\s*\)[\s\S]{0,400}(?:\.remove\(\)|\.removeChild\(|\.parentNode)/,
		];
		expect(
			removalShapes.some((shape) => shape.test(body)),
			'the depth-1 branch must remove a stale ".lineage" suffix from the row'
		).toBe(true);
	});

	it("should call highlightSelection() from ensurePath() right after renderCrumbs()", () => {
		// Arrange: ensurePath 函数体（缺失时 fnBody 直接报红）
		const body = fnBody("ensurePath");

		// Assert（A4）: 成功回调里 renderCrumbs() 之后重跑高亮 —— path 到达即把
		// 祖先行选中态与后缀刷出来
		const crumbsIdx = body.search(/renderCrumbs\(\)/);
		expect(crumbsIdx, "ensurePath must refresh the crumbs").toBeGreaterThan(-1);
		const hlIdx = body.search(/highlightSelection\s*\(\s*\)/);
		expect(hlIdx, "ensurePath must re-run highlightSelection() once the path lands").toBeGreaterThan(-1);
		expect(hlIdx, "highlightSelection() must follow renderCrumbs()").toBeGreaterThan(crumbsIdx);

		// Assert: 调用落在成功回调（catch 之前），失败回调保持已清除态
		const catchIdx = body.search(/\bcatch\s*\(/);
		if (catchIdx > -1) {
			expect(hlIdx, "highlightSelection() must sit in the success handler before the catch").toBeLessThan(catchIdx);
		}
	});

	it("should give .lineage a shrinkable flex: 0 1 auto base rule clamped by a 6em floor and an em cap and hide it inside the 239px container degrade block", () => {
		// Arrange: 全部 .lineage 规则（基础规则 + 239px 降级块 + 可选 441px 放宽）
		const style = pageStyle();
		const bodies = [...style.matchAll(/\.lineage\s*\{([^}]*)\}/g)].map((m) => m[1]);

		// Assert（A5）: 至少两条 —— 基础规则与 239px 降级块内的 display:none
		expect(bodies.length, "missing .lineage CSS rules (base + degrade)").toBeGreaterThanOrEqual(2);

		// Act: 基础规则 = 带单行省略号声明的那条（239px 块只有 display:none、
		// 441px 可选放宽只有 max-width，均被排除）
		const base = bodies.find((b) => /white-space:\s*nowrap/.test(b) && /text-overflow:\s*ellipsis/.test(b));

		// Assert: 可收缩但有区间钳制 + 单行省略号四件套。浏览器实测定稿 ——
		// 无下限的 flex: 0 1 auto 曾把后缀压到 ~0.6px 不可读，故收缩必须带
		// min-width: 6em 下限；max-width 为 em 上限（当前 9em）
		expect(base, "missing the base .lineage rule").toBeDefined();
		for (const decl of [
			/flex:\s*0\s*1\s*auto/,
			/min-width:\s*6em/,
			/max-width:\s*[0-9.]+em/,
			/white-space:\s*nowrap/,
			/overflow:\s*hidden/,
			/text-overflow:\s*ellipsis/,
		]) {
			expect(base, `the base .lineage rule must declare ${decl.source}`).toMatch(decl);
		}

		// Assert: 收缩下限不得为 0（否则退回「被压到 ~0」的缺陷态），且下限不越过
		// 上限（6em ≤ 9em 的自洽区间）
		const baseText = base as string;
		const floor = Number(/min-width:\s*([0-9.]+)em/.exec(baseText)?.[1]);
		const cap = Number(/max-width:\s*([0-9.]+)em/.exec(baseText)?.[1]);
		expect(floor, "the shrink floor must be a positive em value, never 0").toBeGreaterThan(0);
		expect(cap, "the width cap must be a positive em value").toBeGreaterThan(0);
		expect(floor, "the shrink floor must not exceed the width cap").toBeLessThanOrEqual(cap);

		// Assert: 既有 239px 极窄降级块内隐藏 .lineage（极窄窗整体省略）
		const idx = style.search(/@container\s*\(max-width:\s*239px\)/);
		expect(idx, "missing 239px container threshold").toBeGreaterThan(-1);
		const win = style.slice(idx, idx + 400);
		expect(win, "the 239px degrade block must hide .lineage").toMatch(/\.lineage\s*\{[^}]*display:\s*none/);
	});

	it("should let .tid, .elapsed and .child-summary yield to the lineage suffix inside the 340px container block", () => {
		// Arrange: 340px 容器块（花括号配平抽取 —— 让位规则必须落在该块内，
		// 而非散落在别处）
		const style = pageStyle();
		const idx = style.search(/@container\s*\(max-width:\s*340px\)/);
		expect(idx, "missing 340px container threshold").toBeGreaterThan(-1);
		const block = blockAt(style, idx);

		// Assert（A5 让位规则）: 带后缀的行在 ≤340px 容器内让出三列 —— 逐列
		// 断言 .node:has(.lineage) .<col> 选择器存在
		for (const col of ["tid", "elapsed", "child-summary"]) {
			expect(block, `the 340px block must carry .node:has(.lineage) .${col}`).toMatch(
				new RegExp(`\\.node:has\\(\\.lineage\\)\\s+\\.${col}(?![\\w-])`)
			);
		}

		// Assert: 选择器组收敛到同一条 display: none 声明（分号或合并写法均可）
		expect(block, "the :has(.lineage) selector group must declare display: none").toMatch(
			/\.node:has\(\.lineage\)\s+\.child-summary\s*\{[^}]*display:\s*none/
		);

		// Assert: 让位只发生在带后缀的行 —— 块内不得无条件隐藏这三列
		expect(block, "the columns must only yield on rows carrying a lineage suffix").not.toMatch(
			/^[ \t]*\.(?:tid|elapsed|child-summary)\s*\{[^}]*display:\s*none/m
		);
	});

	// ---- 回归锁（天然绿）：点击激活路径与自动滚动不随本轮变化 ----------------

	it("should keep row activation on activateRow(node, …) writing location.hash from node.taskId", () => {
		// Arrange: activateRow 函数体
		const body = fnBody("activateRow");

		// Assert: 行点击仍走 activateRow（既有断言，回归锁）
		expect(PAGE_HTML).toMatch(/row\.addEventListener\("click"[\s\S]{0,400}?activateRow\(/);

		// Assert: 激活仍切到该 depth-1 任务 —— hash 由 node.taskId 构造，
		// 不得改用谱系行 id
		expect(body).toMatch(
			/location\.hash\s*=\s*TASK_PREFIX\s*\+\s*encodeURIComponent\(\s*node\.taskId\s*\)/
		);
		expect(body).not.toMatch(/lineageRowId|lineageLabel/);
	});

	it("should keep autoScrollSidebar on scrollTargetTaskId(state.tree, state.taskId) with no lineage involvement", () => {
		// Arrange: autoScrollSidebar 函数体
		const body = fnBody("autoScrollSidebar");

		// Assert: 滚动目标仍是 scrollTargetTaskId 的既有调用点（深链优先），
		// 不得改为谱系行
		expect(body).toContain("scrollTargetTaskId(state.tree, state.taskId)");
		expect(body, "auto scroll must not target the lineage row").not.toMatch(
			/lineageRowId|lineageLabel|["']\.lineage["']/
		);
	});
});

// ================================================================
// 本轮 B（红阶段，字符串级）：rejected/failed 耗时不得累积
//   B1. src/web/tree-view.ts 新导出纯函数 durationMs(node, nowMs)（真值用例见
//       test/subagent-web-tree-view.test.ts），经 ${durationMs.toString()} 内联
//       —— PAGE_HTML 含 function durationMs(；
//   B2. formatDuration 改为 var ms = durationMs(node, Date.now()); return
//       ms === null ? "—" : formatMs(ms)：终态（rejected/failed/finished）缺
//       finishedAt → "—"（绝不随 Date.now() 变化），pending/running 等非终态
//       保持随时间累积。
// 实现由 coder 落地；本组在 src 未改时全部预期红。
// ================================================================

describe("PAGE_HTML 终态耗时不累积（B，红阶段，字符串级）", () => {
	it("should inline the function durationMs( source into PAGE_HTML", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert（B1，当前应红）: durationMs 的声明字面在页面脚本内
		// （${durationMs.toString()} 插值，同 childSummary/lineageRowId 模式）
		expect(PAGE_HTML, "PAGE_HTML must inline the durationMs declaration").toContain("function durationMs(");
	});

	it('should drive formatDuration from durationMs(node, …) and return "—" when the duration is null', () => {
		// Arrange: formatDuration 函数体
		const body = fnBody("formatDuration");

		// Assert（B2，当前应红）: 耗时计算改由 durationMs 承担（不再直接用
		// Date.now() 冻结 finished 分支）
		expect(body, "formatDuration must call durationMs(node, …)").toMatch(/durationMs\s*\(/);

		// Assert: null 分支返回 "—"（终态缺结束时刻 → 占位符，不随时间变化）
		expect(body, 'formatDuration must return "—" when durationMs is null').toContain('"—"');
		expect(body, "formatDuration must branch on the null duration").toMatch(/null/);
	});
});

// ================================================================
// 本轮 A（红阶段，CSS 契约）：容器 340–440px 区间宽 badge 溢出
//   既有 @container (max-width: 340px) 块只收紧 ≤340px 容器；340–440px 区间
//   此前无任何收紧 —— 默认 .badge max-width: 14em（≈154px）下，宽 agent 名
//   （engineer-legion ≈100px）带谱系后缀的行在该区间横向溢出。契约：新增
//   @container (min-width: 340px) and (max-width: 440px) 块（下界 340px 与
//   ≤340 块在 340 处重叠，消除 340<x<341 的小数死区——容器内容盒
//   340.2px 时 341 下界与 ≤340 块都不匹配，宽 badge 行溢出 +6px），内容与
//   340 块完全相同 —— .badge { max-width: 9.2em; } 收紧徽章，且三条
//   .node:has(.lineage) .tid / .elapsed / .child-summary 让位规则让带后缀的
//   行先让出低优先级三列（色点、badge、task-line、后缀保留）。
// 实现由 coder 落地；本组在 src 未改时预期红。
// ================================================================

describe("PAGE_HTML 340–440px 区间徽章收紧（本轮 A，红阶段，CSS 契约）", () => {
	it("should tighten .badge to 9.2em and let the three low-priority columns yield to lineage rows inside the 340–440px container block", () => {
		// Arrange: 340–440px 双边界容器块 —— 正则宽容空白（min/max 顺序固定、
		// 冒号后空白任意），并用花括号配平把后续断言限定在该块内（防散落规则
		// 蹭过断言，沿用既有 340px 块的 blockAt 手法）
		const style = pageStyle();
		const idx = style.search(
			/@container\s*\(\s*min-width:\s*340px\s*\)\s*and\s*\(\s*max-width:\s*440px\s*\)/
		);
		expect(idx, "missing @container (min-width: 340px) and (max-width: 440px) block").toBeGreaterThan(-1);
		const block = blockAt(style, idx);

		// Assert: 块内 .badge 收紧为 9.2em（与 340 块同值 —— 340–440 区间
		// 重演溢出的直接封堵）
		expect(block, "the 340–440px block must tighten .badge max-width to 9.2em").toMatch(
			/\.badge\s*\{[^}]*max-width\s*:\s*9\.2em/
		);

		// Assert: 三条 .node:has(.lineage) 让位规则逐列落在该块内
		for (const col of ["tid", "elapsed", "child-summary"]) {
			expect(block, `the 340–440px block must carry .node:has(.lineage) .${col}`).toMatch(
				new RegExp(`\\.node:has\\(\\.lineage\\)\\s+\\.${col}(?![\\w-])`)
			);
		}

		// Assert: 让位选择器组收敛到 display: none（分号或合并写法均可）
		expect(block, "the :has(.lineage) selector group must declare display: none").toMatch(
			/\.node:has\(\.lineage\)\s+\.child-summary\s*\{[^}]*display:\s*none/
		);

		// Assert: 让位只发生在带后缀的行 —— 块内不得无条件隐藏这三列
		expect(block, "the columns must only yield on rows carrying a lineage suffix").not.toMatch(
			/^[ \t]*\.(?:tid|elapsed|child-summary)\s*\{[^}]*display:\s*none/m
		);
	});
});
