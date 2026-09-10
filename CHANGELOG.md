# Changelog

All notable changes to Bemby are documented here.

---

## 未发布 / Unreleased

计划任务在升级后保持原定日期，运行日志不再撑爆数据库（实测 527MB → 35MB），面板首屏体积减少约 70%。

Scheduled runs keep their dates across an upgrade, run logs stop filling the database (527MB to 35MB on a real install), and the panel's first load is about 70% smaller.

### 中文

**修复**

- **修复升级后计划任务被重排** -- 此前每次进程启动都会根据"最近一次成功 + 间隔天数"重新推算整张计划表，任何无法从这两项还原的信息都会丢失：失败后的顺延、「跳过这次」的顺延、尚未成功过的任务，以及具体的执行时刻。结果就是原本分散在未来几天的任务在升级后全部挤到同一天（多在深夜重启时集中到第二天，因为当天窗口已过）。现在每次排定的时间都会写回任务本身，重启后直接按原定的那一刻继续；停机期间错过的运行视为欠下的，在下一个可执行时机补上。间隔为一天的签到任务看不出差别，这也是此前一直没被发现的原因。
- **修复日志清理会重置任务节奏** -- 间隔天数原先从日志历史推算，而日志会按"日志保留天数"清理，因此间隔长于保留窗口的任务在每次重启时都会被当作从未运行过、立即执行一次。现改用记在任务上的最近成功时间戳。
- **失败的运行改为次日重试** -- 原先无论成功或失败都顺延一个完整间隔，间隔 7 天的任务失败一次就要再等一周。间隔约束的是两次成功之间的节奏，因此失败只顺延一天。
- **修复最早版本升级后缺少 `job_logs.message` 列** -- 该列只在全新安装的建表语句中，没有对应的 ALTER，因此从最初版本一路升级上来的数据库始终缺它，而每次写运行日志都会用到它。同时新增一项测试，直接比对"从最老结构升级"与"全新安装"两者的全部表结构，任何漏掉的 ALTER 都会在此暴露。
- **修复浏览器脚本步骤取不到 console 输出** -- 「运行脚本」步骤原本通过浏览器的 console 事件收集输出，但任务所用的指纹修补版 Chromium 根本不上报这类事件（这正是它不显眼的一部分），因此"脚本只打印、不返回"的用法始终报"没有返回值"。现改为在页面内收集，与浏览器无关。

**性能**

- **运行日志的截图移出数据库** -- 网页与小程序任务每执行一步都会保存一张页面截图，此前以 base64 直接写入日志行。实测一个安装的数据库为 527MB，其中 500MB 是这些截图，最大的一条日志有 493 张、达 14.7MB。现在截图以文件形式存放在数据目录的 `run-shots/<日志ID>/` 下，行内只保留引用，打开详情时取回显示（面板显示效果不变）。同时每次运行有截图体积上限（约 1.5MB，失败步骤的截图优先保留），长循环从第 3 轮起只在出错时留图，也不再白拍这些图。升级后约 5 分钟会自动把已有日志的截图迁出，并把腾出的空间还给磁盘：实测 527MB → 35MB，836 条日志、18852 条步骤记录一条不少。
- **日志保留与磁盘回收** -- 日志清理会连同其截图一并删除；每天整理一次，清掉无主的截图目录并执行 VACUUM（WAL 模式下还需一次截断式 checkpoint，否则空间只是"可复用"而没有真正还给磁盘）。全新安装的日志保留天数默认为 30 天，已有安装保持原设置不变。
- **面板按需加载** -- 九个视图此前全部静态引入，打包为单个 1.64MB 的 JS，首次打开就要全部下载（含从未打开的帮助页）。现改为按需加载，首屏 JS 降至 350KB，另有 141KB 的第三方库单独打包（升级后仍可命中缓存），首屏 CSS 从 210KB 降至 93KB。升级导致分块文件名变化时，页面会自动重载一次而不是留下空白视图。
- **数据库参数** -- WAL 模式下改用 `synchronous = NORMAL`（进程崩溃仍由 WAL 保证，掉电才需要 FULL），并设置 64MB 缓存与内存映射。调度刷新时的凭据查询与最近成功时间查询也由"每个任务若干次"改为整批一次。

**新功能**

- **日志大小与精简** -- 日志列表新增<strong>大小</strong>列（每次运行占用的空间，含截图文件），工具栏显示当前筛选结果的合计。可精简单条（日志行上的压缩图标）、所选多条（批量操作栏）或全部（工具栏按钮），并指定保留最近几张截图（0 表示全部删除）；步骤记录始终保留，只删截图。新增设置<strong>每次运行保留的截图数</strong>，对之后的运行生效；留空则仅按体积上限裁剪。

### English

**Fixes**

- **Fixed scheduled runs being reshuffled by an upgrade** -- every process start rebuilt the whole plan from "last successful run + run-every-days", so anything not recoverable from those two was lost: a deferral after a failure, a skipped run, a job that had never succeeded yet, and the time of day itself. Runs spread over the coming days all collapsed onto one day after an upgrade, usually the next one, since a late-night restart finds today's windows already past. The time a job is scheduled for is now written to the job, and a restart re-arms that same moment; a run missed while the process was down is treated as owed and goes at the next opportunity. A daily check-in cannot show the problem, which is why it went unnoticed for so long.
- **Fixed log retention resetting a job's cadence** -- the interval was measured from the log history, which the retention window prunes, so any job whose interval was longer than its retention looked never-run and fired immediately on every restart. It now reads the last-success stamp kept on the job.
- **A failed run now retries the next day** -- a run was deferred by its full interval whether it succeeded or not, so one failure on a 7-day job cost a week. The interval is there to space out successful runs, so a failure waits a day.
- **Fixed `job_logs.message` missing after upgrading from the earliest release** -- the column was only in the fresh-install `CREATE TABLE` with no matching ALTER, so a database upgraded all the way from the first version never had it, and every run log insert names it. A test now compares the full schema of an upgraded database against a fresh install, so any missed ALTER fails there instead of on someone's machine.
- **Fixed a browser script step losing its console output** -- the Run a script step collected output through the browser's console events, but the fingerprint-patched Chromium the jobs run on reports none of them (part of how it stays unremarkable to a site), so a script whose only output was what it printed always came back as "gave nothing back". The console is now collected inside the page, which works on any browser.

**Performance**

- **Run screenshots moved out of the database** -- a web or Mini App job saves a picture of the page after every step, and those were written into the log row as base64. One measured install had a 527MB database of which 500MB was these pictures, the worst single log holding 493 of them at 14.7MB. They are now files under `run-shots/<logId>/` in the data directory with a reference in the row, resolved when the detail panel is opened, so the panel looks exactly as it did. A run also has a budget for them (about 1.5MB, a failed step's picture kept ahead of a working one) and past the second round of a long loop only a failing step keeps one, which also stops the pictures being taken at all. About five minutes after the upgrade the screenshots in existing history are moved out and the space returned: 527MB to 35MB on a real install, with all 836 logs and 18,852 step entries intact.
- **Log retention and reclaiming disk** -- a retention purge now deletes the screenshots of the runs it removes, and a daily sweep drops screenshot folders nothing points at any more and vacuums the database (under WAL that needs a truncating checkpoint too, or the pages are merely reusable and the disk never comes back). A fresh install defaults to 30 days of history; an existing one keeps whatever it had.
- **The panel loads its views on demand** -- all nine views were imported into the app shell, so everything shipped as one 1.64MB chunk that every visit downloaded before showing anything, the help page included. First-load JS is now 350KB with the libraries in a separate 141KB chunk that stays cached across upgrades, and first-load CSS is down from 210KB to 93KB. When an upgrade renames the chunks under an open page, it reloads once rather than leaving a blank view.
- **Database settings** -- WAL now runs with `synchronous = NORMAL` (the log already covers the process dying; FULL is for losing power), with a 64MB cache and memory mapping where the file system allows it. The credential and last-success lookups a scheduler refresh makes are now once per batch rather than several times per job.

**Features**

- **Log size and compacting** -- the log list has a <strong>Size</strong> column for what each run costs, screenshot files included, and a total in the toolbar for whatever the filters match. One row (the compress icon), a selection (the bulk bar) or all of them (the toolbar button) can be compacted, keeping however many of the most recent screenshots you ask for, where 0 drops them all; what each step did is always kept. A new <strong>Screenshots to keep per run</strong> setting applies the same trim to future runs, and left blank they are bounded by size alone.

---

## v1.0.0

第一个 1.0 版本：小程序（Mini App）支持、网页子步骤、注册任务增强、计划列表与批量资料生成，Cloudflare 验证改用 CloakBrowser，并完成一轮安全加固。

The first 1.0: Mini App support, page sub-steps, autoreg enhancements, the schedule list, AI-written bulk profiles, Cloudflare solving on CloakBrowser, and a security hardening pass.

### 中文

**变更**

- **在 Messenger 中打开小程序（Mini App）** -- 聊天头部与左侧机器人菜单新增打开按钮，由 Telegram 按当前账户签名后在 Bemby 内查看；机器人菜单里的小程序（贴在输入框旁的那个）也能直接打开。可在设置里切换"应用内 / 浏览器"两种打开方式。
- **小程序内嵌代理** -- 多数小程序拒绝被非 Telegram 站点内嵌，因此内嵌前会先探测；不允许时改由内置代理提供同一页面，剥掉阻止内嵌的响应头，并注入小程序运行时所需的桥接。代理页面使用一次性票据而非面板令牌，票据只对该站点有效，页面脚本读不到（HttpOnly）。设置 `WEBVIEW_PUBLIC_ORIGIN`（指向同一实例的另一个主机名）可让小程序拥有自己的源，从而正确路由自身路径。
- **按网址打开小程序（自定义任务）** -- 新增"打开小程序（网址）"动作：填 `t.me/<机器人>/<应用>` 链接由链接自身确定机器人，填普通 https 地址则由所属机器人签名；另有"打开机器人菜单小程序"动作，无需在聊天记录里翻找按钮。
- **网页子步骤** -- 小程序/网页动作内可编排子步骤：点击、填写、等待元素、滚动（元素或页面）、断言文字；支持 CSS 选择器与多语言标签候选（同一按钮在不同语言下的多种写法）。
- **自定义任务不再必须填目标机器人** -- 纯网页/小程序流程可以完全不涉及聊天。
- **模板复制** -- 模板列表一键复制为新模板（自动命名"（副本）"）。
- **注册任务：正则匹配注册码** -- 群里没有固定前缀时可用正则匹配，有捕获组时取第 1 组；也支持 `/pattern/i` 形式。前缀与正则二者填其一即可。
- **注册任务：注册码即时修正** -- 新增"移除中文字符"与"移除指定字符"两个即时处理（不需要 AI、无额外等待），发送前按群里的约定清理注册码。
- **注册任务：AI 修正注册码** -- 可选开关：发送前把注册码连同群内上下文（该消息、其前后消息、机器人提示）交给 AI，按群里的说明修正（删除干扰符号、替换字符、补全被拆分的码）；一次请求覆盖整批，AI 不可用时按原样发送。
- **注册任务：发送前等待机器人就绪** -- 可分别配置"发送注册码前"与"发送用户名前"要等待的机器人文字（如"对我发送注册码"），避免机器人尚未就绪时白白浪费一个注册码；超时仍会发送并在日志中标注。
- **注册任务：注册码通过后再点击一次按钮/链接** -- 有些机器人先校验注册码，通过后才在回复里给出真正开始注册的按钮或链接。新增开关与匹配文字（留空取第一个可点击项），在"注册码被接受"与"发送用户名"之间点击它；支持回调按钮与 `?start=` 链接（含正文中的文字链接），纯网页链接需要浏览器，请改用自定义任务的"打开网址"动作。该步骤可标记为**必需**（找不到按钮即视为此码失效，直接换下一个）或保持可选（仅记录并继续发送用户名），适配"有时才要求这一步"的机器人。点击后的回复同样按"失败包含文字"判定，因此机器人在此才说"已被使用"时会自动尝试下一个码。
- **用 ID 指定私密群组** -- 没有用户名、也没有邀请链接的私密群组，现在可以用群组 ID 指定：Messenger 的资料面板新增可复制的 ID（`-100…` 形式），任务中的群组/联系人字段都接受该 ID，由本账户的聊天列表解析（因此账户必须已在群内）。邀请链接也可在不重新加入的情况下解析。
- **批量修改资料：AI 生成** -- 批量修改 Telegram 资料时可让 AI 按要求生成（例如"中国用户，简介用中文"）：一次请求覆盖全部账户，可勾选"不生成简介"只生成名字。生成结果会自动清理成可用格式：单行、不含制表符、名字/姓氏 64 字符与简介 70 字符以内、去重、去掉重复的姓氏。
- **计划列表增强** -- 可在设置中把"计划"独立为左侧菜单项（完整列表、不再限高）；每个任务按类型显示图标与颜色（签到 / 观看 / 自定义 / 注册）；每一项可单独取消这次运行——任务保持启用，按其运行间隔顺延到下一个可运行日。
- **显示最近成功时间** -- 任务列表可切换"最近成功"列，显示相对时间（悬停显示完整时间戳）。
- **任务通知改由机器人发送** -- 在设置中填入 BotFather 的机器人 Token 与默认目标（数字 Chat ID，或频道／群组的 `@名称`），任务结束后由该机器人发送通知，不再依赖任务关联账号是否已登录——因此未关联账号的 Emby 观看任务同样能收到通知。机器人无法主动发起对话，故新增**查找会话**从机器人最近的对话中读取 Chat ID，并可**发送测试**立即验证 Token、网络可达性与目标（字段中未保存的值也会被采用，便于先试后存）。Token 仅以掩码回显，留空即保留原值，且在导出时视为敏感项（必须加密导出）。
- **原"由任务账号发送通知"已弃用** -- 未配置机器人 Token 时该方式仍然生效，但将在后续版本中移除：它需要为每条通知建立一次完整的 MTProto 连接，且仅在该账号已登录时可用。设置页在未配置 Token 时给出提示，走该路径时任务日志也会记录一条弃用告警。
- **浏览器配置文件管理** -- 设置中可清理浏览器留下的配置文件（Cookie 与指纹会按出口保留，需要重置时使用）。
- **Cloudflare 验证改用 CloakBrowser** -- 过 CF 的整套浏览器底层已从 `puppeteer-real-browser` + Playwright 下载的普通 Chromium，替换为 **CloakBrowser**：一个在源码层修补指纹（Canvas、WebGL、音频、字体、WebRTC、TLS、`navigator.webdriver` 等）的 Chromium，通过 Playwright 驱动。挑战检测、小程序步骤、网页步骤与代理轮换逻辑保持不变。首次启用时按需下载（约 200MB）到数据目录，升级后仍然保留；旧版本留下的浏览器（`pw-browsers`、`cf-chromium`）会在安装成功后自动清理。
- **CloakBrowser 授权密钥（设置页）** -- 新增密钥管理：不填密钥时使用较旧的免费构建；在 cloakbrowser.dev/free 用 GitHub 账号可免费领取密钥以使用最新构建。每个免费密钥仅允许 1 个并发会话，因此可添加多个（来自不同 GitHub 账号）密钥，运行中的浏览器各占用一个，用完则该次启动回退到免费构建。密钥仅保存在本机，界面始终掩码显示，并可一键验证有效性与套餐。
- **授权构建按需下载** -- 添加授权密钥后，设置页会提示「授权构建尚未下载」，并把安装按钮切换为<strong>下载授权构建</strong>；状态行也会标明当前装的是免费构建还是授权构建。下载始终由你触发，任务运行中不会自动下载。
- **每个出口固定设备指纹** -- 浏览器指纹种子由出口（代理）推导而来，同一出口在多次运行中呈现同一台设备，与其保留的 Cookie（含 `cf_clearance`）一致，而不再每次随机。
- **虚拟显示由应用自行管理** -- headed 模式所需的 Xvfb 现由应用启动并复用（原先由 `puppeteer-real-browser` 负责）；无法启动时回退到 headless 并给出提示。
- **自动更新默认关闭** -- CloakBrowser 的后台自动更新默认关闭，避免任务运行中突然下载约 200MB 并在数据卷中堆积旧构建；更新请使用设置页的「重新下载 / 更新浏览器」。

**安全**

- **登录验证码不再形同虚设** -- 之前验证码答案被签进发给浏览器的令牌里，而 JWT 的载荷是 base64 而非密文，解码即可读到答案；同一个验证码在 5 分钟内还能反复使用。现在答案只保存在服务端，发给客户端的只是一个不透明的 id，且一次验证即作废。
- **修改密码会使旧令牌失效** -- 会话令牌现在带有"纪元"值，修改用户名或密码会推进它，此前签发的所有令牌随即失效。设置页新增<strong>退出所有其他设备</strong>按钮。升级不会让你掉线：第一次修改凭据后才开始生效。
- **Telegram 凭据静态加密** -- 设置 `BEMBY_DATA_KEY` 后，会话字符串、每账户 API hash 与通行密钥私钥在 SQLite 中以 AES-256-GCM 加密存放；已存在的明文会在下次启动时就地加密。未设置时行为不变，但启动时会提示。**请妥善备份该密钥：丢失则相关账户需要重新登录。**
- **SSRF 防护补漏** -- 此前 `::ffff:127.0.0.1` 这类 IPv4 映射地址、`fe80::` 链路本地地址以及 `100.64.0.0/10` 等保留段可以绕过检查。现在按地址本身（而非文本形式）判断，且校验移到了连接时的名称解析上，因此"检查后改答案"的 DNS 重绑定同样被挡住。
- **面板内容安全策略** -- 之前只有 `frame-ancestors`。现在加上 `script-src 'self'`、`object-src 'none'`、`base-uri`、`form-action` 等，日志与消息里渲染的机器人内容即使转义出问题也无法执行脚本。
- **图片地址不再携带会话令牌** -- 聊天图片改用 15 分钟有效的媒体票据，会话令牌不再出现在 URL、浏览器历史与访问日志中。
- **小程序票据按可注册域限定** -- 之前取最后两段，`shop.com.au` 被读成 `com.au`，一张票据等于放行整个后缀下的所有站点。
- **代理密码不再下发** -- 设置接口返回的代理列表中密码以掩码替代，未修改则原样回存（与 API hash 同样的做法）。
- **其他** -- 用户名改为常量时间比较；验证码与凭据接口加上限流；替换式导入在既无存储密码也无 `ADMIN_PASSWORD` 时不再放行空密码；小程序页面的 `frame-ancestors` 取自配置而非请求头；升级 argon2 与 vite，两侧依赖告警清零。

**修复**

- **小程序不再显示自身的错误页** -- Telegram 返回的地址只带账户数据，主题、版本与平台是客户端该补的部分。基于 `@telegram-apps/sdk` 的小程序会校验整套启动参数，缺少主题即抛出"是否在 Telegram 之外打开"，表现为应用自己的报错页（例如 Nebula 的"Oops :("）。现在这些参数会补齐，签名地址与真实客户端一致。
- **模板分享不再带上无关字段** -- 启动命令与签到按钮存在于每个模板上（含默认值），但只有签到与注册任务会用到，分享自定义/观看模板时却一并带出，读起来像是会发送 `/start`、会去找"签到"按钮。现在按任务类型只分享真正相关的字段；导入侧不受影响。
- **Microsoft Edge 最小化后立即还原** -- vue-router 会在 `visibilitychange` 里调用 `history.replaceState` 保存滚动位置，Edge 把它当作"页面被激活"，于是窗口刚最小化就弹回。现在仅在该事件派发期间跳过这一次调用（且只在 Edge 上），后台标签页正常的跳转仍会更新地址栏。
- **任务参数问题** -- 修正自定义任务参数在若干动作间传递时的问题。
- **浏览器测试不再 504** -- 设置页的浏览器测试改为后台执行并轮询结果，长时间的验证不再被反向代理掐断。
- **代理导入导出** -- 修正带代理配置的导入导出。
- **只启动 CloakBrowser 构建** -- 旧版方案会启动 `PUPPETEER_EXECUTABLE_PATH` 指向的浏览器，升级前配置过该变量的安装会继续使用它——那是没有任何指纹修补的普通 Chromium，看似在过验证，实则毫无作用。现在该变量完全不再读取（启动时会提示可删除），数据目录中遗留的 `pw-browsers` / `.pw-browsers` / `cf-chromium` 也会在下次安装时清理。
- **设置页显示的是真正会启动的浏览器** -- 版本号改为从构建目录读取，并新增所用二进制的完整路径。此前是运行该二进制取版本，而授权构建在没有密钥的环境下拒绝启动（密钥存在数据库而非环境变量里），于是页面仍显示被替换掉的旧版本。
- **强制重装不再清空整个缓存** -- 「重新下载 / 更新浏览器」此前会删除全部构建，导致添加密钥后免费构建被一并删除；现在只清除本次要替换的那一档。
- **授权席位不足时排队等待** -- 密钥全部占用时不再直接以无密钥方式启动（授权构建会拒绝运行），而是等待席位释放（上限为单个操作的总时长），使并发数量自动跟随密钥数量。
- **整页验证下发的 Turnstile 令牌不再当作通过** -- Cloudflare 的整页验证会自行完成自己的 Turnstile 并写入令牌，但被拒绝的出口 IP 依然停留在验证页。此前只要看到令牌就判定"已通过"，于是后续网页子步骤在一个根本没有站点内容的页面上空等到超时（例如等待登录框 120 秒），最后才报出误导性的步骤错误。现在整页验证必须真正消失才算通过；站点自己页面上的 Turnstile 组件仍以令牌为准。
- **不再把站点自己的验证组件当作阻塞** -- 许多站点会把 Turnstile 放在自家登录表单里，此时页面完全可用。此前只要页面上存在该组件就中止子步骤，导致能正常打开的登录页也无法填写。现在只有整页验证（页面上没有任何站点内容时）才会中止。
- **不再误触站点自己的按钮** -- 用于"先点一下才会出现验证组件"的验证页的按钮猜测逻辑，此前会在完整站点页面上匹配到"发送验证码"这类文字并点击，等于用空邮箱提交了表单（页面因此显示"邮箱不正确"）。现在仅在控件极少的纯验证页上才会点击。
- **网页子步骤遇到验证会立即停止** -- 子步骤开始前及等待元素期间会检查验证是否占据页面，一旦出现立即中止并说明原因，而不是耗尽各自的超时。
- **判定验证前先等页面就绪** -- 普通网页此前在 `goto` 返回的瞬间就判断有无验证，此时文档可能还是空的，验证会被漏判。现在与小程序一样先等页面就绪。
- **不再把未通过的挑战记为成功** -- 托管挑战会跳转到自己的 URL 并在校验期间短暂清空文档，此前会被误判为「已通过」，从而记录一次并未发生的签到。现在挑战仍在页面上时不认可任何成功信号，且「挑战已消失」需连续两次确认。失败时日志会写明未能通过 Cloudflare 验证。
- **并发连接同一账户会泄漏一个客户端** -- 两个请求同时唤醒同一个闲置账户时，各自建立并连接一个 `TelegramClient`，后者覆盖前者，被覆盖的连接无人可达却持续运行到进程重启。现在共享同一个连接过程。
- **小程序的重定向会被服务端吞掉** -- 站点返回的 3xx 此前在服务端跟完，浏览器地址不变，小程序路由停在被要求离开的页面上；现在按原样转交浏览器。

**清理**

- 移除无引用的导出、失效的单头像与 SSE 路由，以及 27 个未使用的翻译键；导出加密信封、HTML 转义与域名判断的重复实现合并为共用模块。

### English

**Changes**

- **Open a Mini App from Messenger** -- an open button in the chat header and in the bot's left-hand menu; Telegram signs the address for the current account and it opens inside Bemby. The Mini App a bot pins beside the composer (its menu button) opens too, which appears nowhere in the chat history. A setting switches between opening in-app and in the browser.
- **Mini App viewer proxy** -- most Mini Apps refuse to be framed by anything but Telegram, so framing is probed first; where it is refused the same page is served through a built-in proxy with the framing headers dropped and the Mini App bridge injected. The proxied page carries a single-use ticket rather than the panel's session token: it is good for that one site, and HttpOnly so the page's own scripts cannot read it. Setting `WEBVIEW_PUBLIC_ORIGIN` (another hostname pointing at the same instance) gives the app an origin of its own so its router sees its own paths.
- **Open a Mini App by address (custom jobs)** -- an **Open Mini App (URL)** action: a `t.me/<bot>/<app>` link names its own bot, and a plain https address is signed through the bot that owns it. A companion action opens the bot's menu Mini App, so neither needs a button hunted for in the chat history.
- **Page sub-steps** -- steps inside a Mini App or web action: click, fill, wait for an element, scroll (an element or the page), assert text. CSS selectors are supported, as are multi-language label alternatives for a control that is worded differently per locale.
- **A custom job no longer requires a target bot** -- a purely web/Mini App flow need not involve a chat at all.
- **Duplicate a template** -- copy any template into a new one from the list, named "(copy)".
- **Autoreg: match codes by regex** -- for groups whose codes carry no stable prefix; capture group 1 is the code where the pattern has one, and `/pattern/i` works for flags. A prefix or a regex -- one of the two is enough.
- **Autoreg: instant code fixups** -- **Strip Chinese characters** and **Strip these characters** clean a code the way the group asked, with no AI call and nothing to wait for.
- **Autoreg: fix the code with AI** -- optional: before each code is sent the model is shown it along with the group context (its own message, the messages around it, the bot's prompt) and adjusts it as the group instructed -- a decoy symbol to delete, a character to swap, a split code to join. One request covers the batch, and the captured code is sent as it stands if the AI is unavailable.
- **Autoreg: wait for the bot to be ready** -- separate optional waits for the wording that means "send me the code" and "send me the username", so a code is not spent on a bot that is not listening yet. On timeout it is sent anyway and the log says so.
- **Autoreg: click a button/link after the code is verified** -- some bots vet the code first and only then offer the button (or `?start=` link) that actually opens registration. A toggle and its own match text (blank takes the first clickable one) put that click between the code being accepted and the username being sent. Callback buttons and `?start=` links are supported, including a link written into the message text; a plain web link needs a browser, so a custom job's "Open URL" action covers that. The step can be marked **required** (no button means the code is spent, so the next one is tried) or left optional (logged, and the username is sent anyway), which is what a bot that only sometimes asks for the extra click needs. The reply after the click is matched against **Fail contains** too, so a bot that only reports "already used" at that point moves straight on to the next code.
- **Name a private group by its ID** -- a group with no username and no invite link left can now be named by ID: the Messenger Info panel shows a copyable ID (`-100…` form), and a job's group or contact field takes it, resolved from the account's own chat list (so the account must be a member). An invite link also resolves without rejoining.
- **Bulk profile: generate with AI** -- when bulk-updating Telegram profiles, the AI can write them to a requirement ("Chinese users, bios in Chinese"). One request covers every selected account, and a **Skip the bios** toggle asks for names only. What comes back is cleaned to what Telegram and the form accept: one line, no tabs, 64/64/70 character limits, no duplicates, no surname repeated into the given-name field.
- **Schedule list** -- Settings can give **Schedule** its own menu entry, showing the full list without the height cap. Each chip carries an icon and colour for its job type (check-in / watch / custom / autoreg), and each can be called off individually: the job stays enabled and moves to its next eligible day, respecting its run-every-days interval.
- **Last successful run** -- a toggleable column on the jobs list showing how long ago each job last succeeded, with the full timestamp on hover.
- **Job notifications are sent by a bot** -- set a bot token from BotFather and a default target (a numeric chat ID, or a channel's / group's `@name`) in Settings, and that bot sends when a job finishes. Notifications no longer depend on the job's account being authenticated, so an Emby Watch job with no linked account gets them too. A bot cannot start a conversation, so **Find chats** reads the chat IDs it has heard from lately, and **Send test** proves the token, the host's reachability and the target at once (an unsaved token or target in the fields is used, so either can be tried before it is committed). The token is only ever echoed back masked, blank keeps the stored one, and it counts as sensitive on export, which must then be encrypted.
- **Sending notifications from a job's account is deprecated** -- it still applies while no bot token is set, but it will be removed in a future release: it opens a full MTProto connection per notification and only works while that account is authenticated. Settings warns while no token is configured, and a run that takes that path logs a deprecation warning.
- **Browser profile housekeeping** -- clear the profiles the solver keeps per exit (cookies and fingerprint) from Settings when a reset is wanted.
- **Cloudflare solving now runs on CloakBrowser** -- the whole browser layer behind CF solving moved from `puppeteer-real-browser` plus a Playwright-downloaded stock Chromium to **CloakBrowser**: a Chromium whose fingerprint is patched at source (canvas, WebGL, audio, fonts, WebRTC, TLS, `navigator.webdriver`), driven through Playwright. Challenge detection, Mini App steps, page steps and proxy rotation are unchanged. It is downloaded on demand (~200MB) into the data dir so it survives an upgrade, and the browsers earlier versions left behind (`pw-browsers`, `cf-chromium`) are removed once the new one installs.
- **CloakBrowser licence keys (Settings)** -- with no key the solver runs the older free build; a free key (one per GitHub account at cloakbrowser.dev/free) gets the current one. A free key allows a single concurrent session, so several keys can be stored and one is leased per running browser, with a launch falling back to the free build when every seat is taken. Keys are stored on the host, only ever shown masked, and can be checked for validity and plan from the same panel.
- **The licensed build is offered as a download** -- once a key is added, Settings says the build it unlocks has not been downloaded and the install button becomes <strong>Download the licensed build</strong>; the status line names which build is on disk. Downloads still only happen when you ask, never mid-job.
- **A stable device per exit** -- the browser fingerprint seed is derived from the exit (proxy) rather than chosen at random each launch, so an exit presents the same machine run after run, matching the cookies its profile keeps (`cf_clearance` included).
- **The app manages its own virtual display** -- the Xvfb that headed mode needs is now started and shared by the app itself (it used to come from `puppeteer-real-browser`), falling back to headless with a warning when it cannot be started.
- **Auto-update off by default** -- CloakBrowser's background update is disabled, so a job no longer triggers a surprise ~200MB download mid-run or leaves superseded builds on the data volume. Use "Re-download / update browser" in Settings instead.

**Security**

- **The login captcha was decorative** -- the answer was signed into the token handed to the browser, and a JWT payload is base64 rather than ciphertext, so decoding it gave the answer; the same challenge was also replayable for its full five minutes. The answer now stays on the server, the client gets an opaque id, and a challenge is good for one attempt.
- **Changing the password now invalidates existing tokens** -- session tokens carry an epoch, and changing the username or password advances it, retiring every token issued before it. Settings gains a **Sign out all other devices** button. Upgrading does not sign you out: the epoch only starts to bite after the first credential change.
- **Telegram credentials are encrypted at rest** -- with `BEMBY_DATA_KEY` set, session strings, per-account API hashes and passkey private keys are stored AES-256-GCM encrypted, and anything already in plain text is encrypted in place on the next start. Behaviour is unchanged without the key, but the boot log says so. **Back the key up: lose it and the affected accounts have to be authenticated again.**
- **SSRF gaps closed** -- IPv4-mapped addresses such as `::ffff:127.0.0.1`, link-local `fe80::` and reserved ranges like `100.64.0.0/10` previously passed the check. Addresses are now judged as addresses rather than as text, and the check moved onto the connection's own name resolution, so a DNS answer that changes between the check and the connection is caught too.
- **A real content security policy for the panel** -- previously `frame-ancestors` alone. Now `script-src 'self'`, `object-src 'none'`, `base-uri` and `form-action` as well, so bot-authored content rendered in the logs and the messenger cannot execute even if the escaping around it ever slips.
- **Image addresses no longer carry the session token** -- chat photos use a 15-minute media ticket, keeping a seven-day credential out of URLs, browser history and access logs.
- **Mini App tickets are scoped to the registrable domain** -- the old last-two-labels rule read `shop.com.au` as `com.au`, so one ticket authorised every site under that suffix.
- **Proxy passwords are no longer sent to the client** -- the settings response masks them and restores the stored value when it comes back unchanged, the same round trip the API hash already made.
- **Also** -- constant-time username comparison; rate limits on the captcha and credential endpoints; replace-mode import no longer accepts an empty password when neither a stored hash nor `ADMIN_PASSWORD` exists; the Mini App page's `frame-ancestors` comes from configuration rather than the request's Host header; argon2 and vite updated, leaving both dependency trees with no advisories.

**Fixes**

- **A Mini App no longer opens on its own error page** -- Telegram returns an address carrying only the account data; the theme, version and platform are the client's part to add. An app built on `@telegram-apps/sdk` validates the whole launch-parameter set and throws "opened outside Telegram?" when the theme is missing, which surfaces as the app's own error screen (Nebula's "Oops :(", in the report). Those parameters are filled in now, so a signed address matches what a real client hands over.
- **A shared template no longer carries fields it never uses** -- the start command and check-in button exist on every template, defaulted, but only check-in and autoreg jobs read them; sharing a custom or watch template brought them along, reading as though it sends `/start` and hunts for a 签到 button. Only the fields the job type actually uses are shared now; importing is unaffected.
- **Microsoft Edge restored a minimised window immediately** -- vue-router saves the scroll position with `history.replaceState` inside a `visibilitychange` handler, which Edge reads as the page being activated, so the window popped straight back up. That one call is now skipped for the duration of the event dispatch (and only on Edge), leaving genuine navigation in a background tab free to update the address bar.
- **Job parameters** -- fixed parameters not carrying correctly between several custom-job actions.
- **Browser tests no longer 504** -- the Settings browser test runs in the background and is polled for its result, so a long solve is not cut off by a reverse proxy.
- **Proxy import/export** -- fixed importing and exporting configurations that carry proxies.
- **Only CloakBrowser builds are launched** -- the previous solver ran whatever `PUPPETEER_EXECUTABLE_PATH` named, and installs that were set up before the switch kept using it: a stock Chromium with none of the fingerprint patches, which looks like it is solving challenges without doing any of the work. The variable is no longer read at all (a startup line says so), and the browsers left in the data dir (`pw-browsers`, `.pw-browsers`, `cf-chromium`) are cleaned up on the next install.
- **Settings names the browser that will actually launch** -- the version is read from the build directory and the full binary path is shown. It used to come from running the binary, which the keyed build refuses to do without its licence key (the key lives in the database, not this process's environment), so the page went on naming the build it had replaced.
- **A forced reinstall no longer empties the whole cache** -- "Re-download / update browser" deleted every build, so adding a key and reinstalling took the free build with it. Only the tier being replaced is cleared now.
- **Launches queue for a licence seat** -- with every key in use a browser no longer starts keyless (which the keyed build refuses); it waits for a seat, bounded by the budget one action gets, so how many solvers run at once follows how many keys are configured.
- **A Turnstile token from a full-page interstitial no longer counts as a pass** -- Cloudflare's interstitial satisfies its own Turnstile and fills the token field in, while an exit IP it has decided against stays on the interstitial. The token alone used to be read as "solved", so the page steps then ran against a page with none of the site on it and waited out their whole timeout (two minutes for a login field, in one report) before failing with a misleading step error. The interstitial now has to actually go away; a Turnstile the site itself put on its page still passes on the token.
- **A widget the site put on its own page no longer blocks anything** -- plenty of sites place a Turnstile inside their login form, where the page around it is perfectly usable. Treating any widget on the page as blocking stopped the steps on login pages that had loaded fine. Only a full-page interstitial, where none of the site is on screen, stops them now.
- **The site's own buttons are no longer pressed** -- the guess used for verify portals that only render their widget after a click matched labels like "发送验证码" on a full site page and pressed it, submitting the login form with an empty field (which is where the "邮箱不正确" in the screenshot came from). It now only fires on a near-empty verify page, and the decision is a tested function rather than a regex buried in a page script.
- **Page steps stop as soon as a challenge owns the page** -- checked before each step and while waiting for an element, so a challenge raised mid-run ends the step with the real reason instead of running out its timeout.
- **The page is allowed to arrive before it is judged** -- a plain page used to be checked for a challenge the instant `goto` returned, when the document can still be empty and the interstitial has written nothing; it now waits for readiness the way a Mini App already did.
- **A refused challenge is no longer logged as a pass** -- a managed challenge navigates to its own URL and briefly empties the document while it verifies, which used to read as "cleared" and recorded a checkin that never happened. Nothing counts as success while the interstitial is still up, and "the challenge is gone" now has to hold across two consecutive checks. The job log says plainly when the Cloudflare challenge was not passed.
- **Connecting the same account twice at once leaked a client** -- two requests waking the same idle account each built and connected a `TelegramClient` and the second overwrote the first, leaving a live connection nothing could reach that ran until the process restarted. They now share one connection.
- **Mini App redirects were swallowed server-side** -- a 3xx from the site was followed on the server, so the browser's address never changed and the app's router stayed on the page it had been told to leave. Redirects are now relayed to the browser.

**Cleanup**

- Unreferenced exports, the dead single-avatar and SSE routes and 27 unused translation keys removed; the export encryption envelope, HTML escaping and domain matching each collapsed from duplicate copies into one shared module.

---

## v0.9.36-patch-1

### 中文

- **修复 Emby 观看导致内存耗尽（OOM）而进程被终止** -- 播放前的可用性探测只请求前 64KB，但当 Emby 服务器（或其前置反向代理）忽略 `Range` 头、以 `200` 返回整个文件时，探测代码会把整部影片读入内存。实测一个 800MB 的文件会使内存占用峰值达到约 2.5GB，在 2GB 内存的机器上进程会被系统直接终止。现改为只读取一个数据块即停止并释放连接，无论服务器如何响应都不再受文件大小影响。这也是"调度执行失败、手动执行却能成功"的原因：每次运行都会随机挑选影片，抽到大文件才会崩溃，而调度执行的次数远多于手动执行。
- **修复真实观看在服务器忽略 `Range` 时拉取整部影片** -- 现按本次时间窗口所需的字节数为上限，超出即停止；HLS 分片与未知文件大小的情形保持原有行为。
- **减少代理模式下的内存占用** -- Emby 观看此前每个请求都新建一个代理连接池，其保持连接直到超时才释放。现按代理地址复用同一个连接池。
- **修复未完成的登录会话泄漏 Telegram 连接** -- 请求验证码后若未继续完成登录（关闭页面、批量添加已跳过等），该已连接的客户端会一直驻留到进程结束。现超过 15 分钟自动销毁并释放。
- **限制同时保持的 Telegram 连接数** -- 每个已连接账户都会占用数 MB 内存；无人查看的连接在超过上限（默认 8，`TG_LIVE_CLIENT_MAX`）后按最久未使用顺序断开。正在查看的账户不会被断开。
- **限制消息页面的媒体大小** -- 内联查看媒体需要将整个文件读入内存，超过上限（默认 25MB，`TG_MEDIA_MAX_MB`）的文件不再加载。发送文件的大小上限可通过 `TG_UPLOAD_MAX_MB` 调整。
- **限制 Node 堆内存上限** -- 镜像默认设置 `--max-old-space-size=512`，适配 2GB 内存的机器；内存更大的机器可通过覆盖 `NODE_OPTIONS` 调整。
- **新增内存监控** -- 设置页面新增<strong>内存使用</strong>卡片，显示当前占用、本次启动峰值、外部内存与可用上限。占用超过上限的 75%（`MEMORY_WARN_PERCENT`）时会在日志中告警并指出当时正在运行的任务。进程被系统强制终止时无法自行留下记录，因此内存数据会定期写入数据库；下次启动会报告上次退出前的占用量以及当时运行的任务，用于判断是否为内存不足所致。

### English

- **Fixed Emby Watch exhausting memory and getting the process killed** -- the playability probe asks for only the first 64KB, but when the Emby server (or a reverse proxy in front of it) ignores the `Range` header and answers `200` with the whole file, the probe read the entire movie into memory. Measured against an 800MB file, memory peaked at roughly 2.5GB, which is fatal on a 2GB machine. It now reads a single chunk and releases the connection, so the cost no longer depends on the file size however the server responds. This is also why scheduled runs failed while manual runs succeeded: each run picks a random item, so only an unlucky draw crashed, and the scheduler draws far more often than you do by hand.
- **Fixed Real Watch pulling a whole movie when the server ignores `Range`** -- it now stops once it has the bytes this interval needs. HLS segments and unknown file sizes behave as before.
- **Reduced memory use when a proxy is configured** -- Emby Watch built a new proxy connection pool for every request and left its keep-alive sockets open until they timed out. One pool per proxy address is now reused.
- **Fixed unfinished logins leaking a Telegram connection** -- after requesting a code, a login that was never completed (tab closed, a bulk add that moved on) left its connected client in memory for the life of the process. Sessions older than 15 minutes are now destroyed.
- **Bounded the number of simultaneous Telegram connections** -- every connected account costs several MB. Connections nobody is watching are dropped least-recently-used once past the limit (default 8, `TG_LIVE_CLIENT_MAX`). An account being watched is never dropped.
- **Bounded media size in the Messenger** -- viewing media inline buffers the whole file in memory, so anything over the limit (default 25MB, `TG_MEDIA_MAX_MB`) is no longer loaded. The outgoing file size limit is configurable with `TG_UPLOAD_MAX_MB`.
- **Capped the Node heap** -- the image now sets `--max-old-space-size=512`, which suits a 2GB machine. Override `NODE_OPTIONS` on a larger host.
- **Added memory monitoring** -- Settings gained a <strong>Memory Usage</strong> card showing current, peak, external and the available limit. Passing 75% of the limit (`MEMORY_WARN_PERCENT`) logs a warning naming the job in flight. A process killed by the system cannot record its own death, so readings are written to the database periodically; the next start reports how much the previous process was holding and which job was running, which is what tells you whether it ran out of memory.

---

## v0.9.36

### 中文

**新功能**

- **真实观看（拉取实际字节）** -- Emby 观看新增<strong>真实观看</strong>开关：以真实播放速率从 Emby 服务器直连拉取实际媒体字节，使服务器看到与真实客户端一致的串流流量，而不只是进度上报。日志会显示本次<strong>已串流</strong>的数据量。注意：会消耗大量下行流量（单次可达数百 MB 至数 GB）。
- **顺序播放（续播）** -- Emby 观看新增<strong>顺序播放</strong>开关：优先从上次离开的位置继续观看（Emby「继续观看」），其次是下一集（Next Up），仍无则随机选择；当前集看完后自动播放同剧集的下一集，直到用尽播放时长。仅在实际看完整集时才标记为已看，未看完的内容会保留在「继续观看」列表中。日志详情会列出本次播放的每一集，并显示<strong>顺序播放集数</strong>与<strong>总观看时长</strong>。
- **限定媒体库** -- Emby 观看新增<strong>限定媒体库（可选）</strong>：填写媒体库名称或其序号（从 1 开始），仅从该库中挑选内容（含续播与顺序播放）。若找不到该媒体库，或库内没有可播放内容，则自动回退到整个服务器。
- **执行间隔支持范围** -- 任务与模板的<strong>每隔多少天执行</strong>可填范围（如 <code>7-15</code>）：每次排程时在范围内随机取一个天数，使执行节奏不再固定；填单个数字（如 <code>7</code>）行为不变。
- **批量修改 Telegram 资料** -- 批量操作新增<strong>批量修改资料</strong>：为所选已认证账户批量设置名字、姓氏和简介，每行对应一个账户、字段用制表符（Tab）分隔，可从表格直接粘贴，也可一键<strong>生成随机名字</strong>。作为后台批量任务运行（页面刷新不中断），账户之间按间隔依次处理并对失败账户自动重试。
- **账户列表排序** -- 账户表格的名称、手机号、状态、添加时间列支持点击排序（升序 → 降序 → 恢复手动顺序），排序状态跨刷新保留；排序或搜索状态下会停用拖拽排序，避免对筛选后的子集重排造成误解。

**修复**

- **中止 Emby 观看任务** -- 从日志中停止正在运行的 Emby 观看任务时会立即中止（包括串流与等待过程中），并如实记为已取消，而不再继续重试。
- **限定媒体库的可靠性** -- 修复部分经反向代理的 Emby 服务器上媒体库范围失效的问题：续播/下一集与随机挑选现在会按媒体库归属校验，避免选到库外内容。

### English

**Features**

- **Real Watch (stream actual bytes)** -- Emby Watch gained a <strong>Real Watch</strong> toggle: the actual media bytes are pulled from the Emby server at real playback pace (direct play), so the server sees genuine streaming traffic like a real client instead of progress reports alone. The log shows how much was <strong>Streamed</strong>. Note: this uses significant download bandwidth (hundreds of MB to GBs per run).
- **Sequence Play (resume & continue)** -- Emby Watch gained a <strong>Sequence Play</strong> toggle: it resumes from where the user left off (Emby Continue Watching), falling back to the next unwatched episode (Next Up) and then a random item; when an episode finishes it plays the next one in the show until the play duration is used up. An episode is only marked watched when it actually finishes, so a partly-watched item stays in Continue Watching. The log detail lists every episode played this run, along with <strong>Episodes played</strong> and <strong>Total watched</strong>.
- **Limit to library** -- Emby Watch gained <strong>Limit to library (optional)</strong>: enter a library name or its index (starting from 1) to pick content only from that library, including resume and Sequence Play. If the library can't be matched, or has nothing to play, it falls back to the whole server.
- **Run every (days) accepts a range** -- jobs and templates accept a range for <strong>Run every (days)</strong> (e.g. <code>7-15</code>): a random day count within the range is picked each time the job schedules, so the cadence is no longer fixed. A single number (e.g. <code>7</code>) behaves as before.
- **Bulk Rename TG Profile** -- a new bulk action that sets the first name, last name and intro of the selected authenticated accounts. One line per account with fields separated by a Tab, so columns can be pasted straight from a spreadsheet, or use <strong>Generate random names</strong> to fill them. It runs as a background batch that survives page reloads, processing accounts one at a time with the shared gap between them and retrying failures.
- **Sortable accounts table** -- click the Name, Phone, Status, or Added column header to sort (ascending → descending → back to the manual drag order); the choice is remembered across refreshes. Drag reordering is disabled while sorting or searching, since reordering a filtered subset is misleading.

**Fixes**

- **Cancelling an Emby Watch job** -- stopping a running Emby Watch job from the log list now aborts it immediately (including mid-stream and mid-wait) and reports it as cancelled instead of retrying.
- **Library scoping reliability** -- fixed library scoping on Emby servers behind a reverse proxy: resume / Next Up and random selection now verify that the chosen item really belongs to the target library, so out-of-library content is no longer picked.

---

## v0.9.35

### 中文

**新功能**

- **消息范围（Scope）—— ⚠️ 请留意，可能影响既有自定义任务** -- "等待回复""点击按钮""点击消息按钮"等动作新增<strong>消息范围</strong>设置，用于限定动作查看哪些消息。默认值 <code>0</code> 表示只处理发送命令之后的新回复（以上一条已发送消息为锚点），可避免误点发送命令之前的旧按钮。<strong>既有自定义任务若依赖点击更早消息上的按钮，升级后可能因默认范围而找不到目标</strong>——此时请将该动作的消息范围设为负值（如 <code>-1</code> 额外包含发送前最近 1 条消息，<code>-3</code> 为最近 3 条）以恢复原有行为。
- **点击多个按钮（AI 选择）** -- 自定义任务新增"点击多个按钮（AI 选择）"动作：AI 根据消息内容返回一组按钮文字（JSON 数组，避免按钮文字含逗号等分隔符时产生歧义），Bemby 按顺序依次点击，每次点击之间可配置<strong>点击间隔（毫秒）</strong>。适用于需要按顺序点选多个选项的流程（如人机验证）。留空<strong>联系人</strong>则在任务机器人的对话中操作，填写则在该联系人对话中操作。可选配<strong>成功包含文字</strong>（仅在最后一次点击后校验，因确认消息通常在整段序列完成后才出现）与<strong>失败包含文字</strong>（每次点击后校验，出现即中止）。若 AI 选择无法完整匹配可用按钮，或任一按钮在重试后仍无法点击，则整个动作失败。

### English

**Features**

- **Message scope -- ⚠️ heads-up, may affect existing custom jobs** -- **Wait for reply**, **Click button**, and **Click message button** actions gained a <strong>Message scope</strong> setting that limits which messages an action considers. The default of <code>0</code> only looks at new replies after the command was sent (anchored to the last sent message), which avoids clicking a stale button from before the command. <strong>Existing custom jobs that relied on clicking a button on an earlier message may no longer find their target after upgrading</strong> -- set that action's Message scope to a negative value (e.g. <code>-1</code> to also include the last message before the send, <code>-3</code> for the last 3) to restore the previous behaviour.
- **Click multiple buttons (AI picks)** -- a new custom-job action: the AI returns an ordered list of button texts (a JSON array, so labels containing commas or other delimiters stay unambiguous) based on the message, and Bemby clicks each in order with a configurable <strong>gap between clicks (ms)</strong>. Useful for flows that require selecting several options in sequence (e.g. a captcha). Leave <strong>Contact</strong> blank to operate in the job's bot chat, or set one to operate in that chat. Optional <strong>Success contains</strong> is checked only after the final click (the confirmation usually appears once the whole sequence is done) and <strong>Fail contains</strong> is checked after every click (aborting on the first match). The action fails if the AI selection can't be fully matched to available buttons, or if any button still can't be clicked after its retries.

---

## v0.9.34

### 中文

**新功能**

- **通行密钥（Passkey）注册、登录与验证** -- 可为账户添加通行密钥（"添加通行密钥"），整个 WebAuthn 注册流程在服务端完成，无需浏览器操作，每个账户存储一个通行密钥。已持有通行密钥的账户，登录对话框中会出现"使用通行密钥登录"：先以通行密钥登录，随后仅需输入 2FA 密码即可完成。"验证"操作用于确认 Telegram 仍接受已存储的通行密钥。另提供"批量添加通行密钥"，会自动跳过（并顺带验证）已持有 Bemby 通行密钥的账户。（实验性功能）
- **批量重命名** -- "批量重命名" 按名称格式批量重命名所选账户，`{index}` 会替换为递增序号，可配置起始序号与序号位数（补零），并提供实时预览
- **批量获取属性** -- "获取属性" 为所选已认证账户刷新 TG 信息及附加属性（名称、用户名、登录邮箱、通行密钥状态），不执行发消息许可检测
- **批量修改登录邮箱** -- "批量修改登录邮箱" 使用 `+` 标签模板为所选账户设置登录邮箱，模板支持 `{phoneNum}`、`{tgId}`、`{id}` 及随机变量（`{word:4}`、`{alpha:8}`、`{uuid}`）；因 Telegram 拒绝纯数字邮箱标签，数字会映射为字母（0=a … 9=j）。确认码通过 Gmail 应用专用密码经 IMAP 读取（仅用于本次运行，绝不存储），开始前需先"测试登录"
- **批量修改凭据** -- "批量修改凭据" 为所选账户批量设置/轮换 2FA 密码，可选同时"移除其他所有已登录设备"、"移除其他所有通行密钥（保留 Bemby 管理的）"，并可按模板将结果追加至备注
- **额外信息列** -- 账户现可存储更多元信息（登录邮箱、受限状态、通行密钥标记）；新增"显示额外信息 / 隐藏额外信息"切换与"额外信息"列，展示 Bemby 通行密钥、通行密钥、登录邮箱、受限状态等属性
- **批量添加账户（需开启）** -- "批量添加账户" 每行粘贴 `手机号----API网址`，Bemby 先批量创建账户，再逐个认证：请求验证码、从各账户的 API 网页读取验证码与 2FA 密码、按配置的间隔等待后处理下一个（仅填手机号则只创建不认证）。"选项"面板支持逐账户间隔、名称前缀与编号方案、备注模板（`{apiUrl}` 逐账户展开）、候选设备/代理/API ID Hash（逐账户随机选取，可"批量粘贴"多组 API 凭据），以及提取验证码/2FA 的自定义正则。此功能与"批量清理"均需设置环境变量 `BULK_ACCOUNT_MANAGEMENT=1` 才会显示
- **Shift 范围选择** -- 账户表格中可按住 Shift 点击，选中上次点击行与本次点击行之间的连续区间
- **精简账户视图 / 批量操作菜单** -- 账户视图重构为更少的行内按钮，批量操作统一收纳至"批量操作"菜单
- **账户间间隔** -- 各顺序批量操作共用"每个账户之间的间隔（秒）"设置（0 表示不等待），避免触发 Telegram 限流
- **备份包含通行密钥与账户属性** -- 数据导出/导入现随账户一并携带其通行密钥与附加属性；包含通行密钥私钥的备份导出时会强制加密
- **更清晰的认证错误提示** -- 认证流程改为返回具体且已本地化的错误（验证码错误、验证码已过期、操作过于频繁），不再是笼统的失败提示

**修复**

- **修复 Emby 观看自定义 User Agent 未生效** -- Emby 会话的应用名与版本此前无论选择何种 UA 都被硬编码为 `SenPlayer` / `6.1.0`，现从所选 UA 中解析客户端名称与版本，自定义 UA 预设可在 Emby 后台正确显示
- **修复回调按钮点击超时被误判为失败** -- 按钮点击回调触发 `BOT_RESPONSE_TIMEOUT` 时，即便签到实际已生效仍被判为失败。现重新拉取消息，若 `editDate` 已变化则视为机器人已处理点击，不再误报失败
- **修复无法添加通行密钥**
- **修复通行密钥登录标记判断错误** -- 登录对话框此前用了错误的标记（`hasPasskey`，包含非 Bemby 通行密钥），现改用 `hasBembyPasskey`，仅在 Bemby 确实持有私钥时才触发"通行密钥 + 2FA"自动流程
- **修复批量清理按钮文案与层级** -- 批量发消息许可检测按钮误显示为"开始清理"，现更正为"开始检测"，并修正中文文案错别字
- **修复账户视图弹窗样式** -- 提高弹窗遮罩层级，使其位于移动端头部与侧边栏之上（标题不再被遮挡）；弹窗内容过长时可滚动，底部按钮始终固定可点击

### English

**Features**

- **Passkey register, log in, and verify** -- add a passkey to an account (**Add passkey**) via a fully server-side WebAuthn registration ceremony (no browser needed), storing one passkey per account. Accounts holding a passkey get **Log in with passkey** in the auth dialog: it logs in with the passkey and then prompts only for the 2FA password. A **Verify** action confirms Telegram still accepts the stored passkey, and **Bulk Add Passkey** skips (and verifies) accounts that already hold a Bemby passkey. (Experimental)
- **Bulk rename** -- **Bulk Rename** renames selected accounts by a name format where `{index}` becomes a running number, with a configurable start index and index digits (zero-padding) and a live preview
- **Bulk fetch attributes** -- **Fetch Attributes** refreshes TG info and extra attributes (name, username, login email, passkey status) for selected authenticated accounts, without running the send-permission check
- **Bulk change login email** -- **Bulk Change Login Email** sets a login email on selected accounts using a `+`-tag template with variables (`{phoneNum}`, `{tgId}`, `{id}`, and random `{word:4}`, `{alpha:8}`, `{uuid}`); digits are mapped to letters (0=a … 9=j) because Telegram rejects numeric email tags. Codes are read from Gmail over IMAP using a Gmail app password (used only for the run, never stored), with a required **Test login** step first
- **Bulk change credential** -- **Bulk Change Credential** sets/rotates the 2FA password across selected accounts, with optional "remove all other logged-in devices" and "remove all other passkeys (keep Bemby-managed)", plus an append-to-notes-on-success template
- **Extra Info column** -- accounts now store more meta info (login email, restriction status, passkey flags); a new **Show / Hide Extra Info** toggle and **Extra Info** column surface attributes such as Bemby Passkey, Passkey, Login Email, and Restriction
- **Bulk add accounts (opt-in)** -- **Bulk Add** takes one `phone----apiUrl` per line, creating every account first and then authenticating each one sequentially: request the code, read the verification code and 2FA password back from the account's API web page, wait a configurable gap, and move on (a phone-only line creates without authenticating). The **Options** panel adds a per-account gap, a name prefix and numbering scheme, a notes template (`{apiUrl}` expands per account), candidate device/proxy/API ID-Hash pickers (chosen at random per account, with **Bulk paste** for multiple API credential pairs), and custom regexes for extracting the code / 2FA. This feature and **Bulk Clean** are hidden unless `BULK_ACCOUNT_MANAGEMENT=1` is set in the environment
- **Shift-click range selection** -- hold Shift and click in the accounts table to select the contiguous range between the last-clicked row and the shift-clicked row
- **Slimmer account view / Bulk Actions menu** -- the account view was refactored to show fewer inline buttons, with bulk operations consolidated under a **Bulk Actions** menu
- **Gap between accounts** -- a shared "Gap between accounts (seconds)" control (0 = no wait) across the sequential bulk operations avoids Telegram flood limits
- **Backups carry passkeys and account attributes** -- data export/import now carries each account's stored passkey and additional attributes inline; a backup containing a passkey private key is forced to be encrypted on export
- **Clearer auth error messages** -- the auth flow now returns specific, localised errors (invalid verification code, code expired, too many attempts) instead of a generic failure

**Fixes**

- **Fix Emby watch custom User Agent not taking effect** -- the Emby session's app name and version were hardcoded to `SenPlayer` / `6.1.0` regardless of the chosen UA. The client name and version are now parsed from the selected UA, so a custom UA preset shows correctly in the Emby dashboard
- **Fix callback button-click timeout wrongly reported as failure** -- a `BOT_RESPONSE_TIMEOUT` on a button-click callback was treated as a failure even though the check-in often still registered. The job now re-fetches the message and treats a changed `editDate` as proof the bot processed the click, so those runs are no longer reported as failed
- **Fix passkeys could not be added**
- **Fix wrong passkey login flag** -- the auth dialog gated the passkey shortcut on the wrong flag (`hasPasskey`, which includes non-Bemby passkeys); it now uses `hasBembyPasskey`, so the automatic passkey-then-2FA flow triggers only when Bemby actually holds the key
- **Fix bulk clean button label and z-index** -- the bulk send-permission check button incorrectly showed the "Start Cleaning" label; it now reads "Start Check", and a Chinese typo was corrected
- **Fix account view modal style** -- the modal overlay z-index was raised above the mobile header and sidebar (the title is no longer covered), the modal body now scrolls for tall content, and the footer buttons stay pinned to the bottom and reachable

---

## v0.9.33-patch-1

### 中文

- **修复手动执行任务报错（Issue #21）** -- 手动运行任务时，若任务以非 Error 对象拒绝，错误处理代码直接读取 `err.message` 会抛出 `TypeError: Cannot read properties of undefined (reading 'message')`，进而变成未处理的拒绝：日志记录永久卡在"运行中"，真实的失败原因也被掩盖。现所有错误处理统一先规整错误值，任务失败会正确记录为"失败"并显示真实错误信息（调度任务路径存在同样问题，一并修复）
- **修复调度器可能停止执行所有任务** -- 并发槽在写入运行日志之前就被占用，若该写入失败（数据库繁忙、锁、磁盘满等），槽位永不释放；累计到并发上限后调度器彻底卡死，重启前不再执行任何任务。现将槽位纳入 `try/finally`，确保始终释放
- **修复运行中被禁用/删除的任务仍会重新排期** -- 任务运行结束后无条件重新排期，即使它已在运行途中被禁用或删除。现仅在任务仍存在且启用时才重新排期
- **修复登录发送验证码失败时泄漏连接** -- 请求验证码时若 `sendCode` 失败（号码无效/被封、触发限流等），已连接的 Telegram 客户端无人引用且永不销毁。现失败时会销毁该客户端
- **修复导入损坏备份时请求卡死** -- 导入畸形备份文件时事务内抛错会逃逸为未处理拒绝，请求永久无响应。现返回明确的错误提示，且账号导入与模板批量创建改为事务化，中途失败会整体回滚而非留下残缺数据
- **修复编辑使用默认 API 凭据的账号会损坏其 API ID** -- 编辑此类账号（`api_id` 为空）时会把 API ID 写成 `0`。现保留原值

### English

- **Fix manual task run error (issue #21)** -- when a manually-run job rejected with a non-Error value, the error handler read `err.message` directly and threw `TypeError: Cannot read properties of undefined (reading 'message')`, which became an unhandled rejection: the log row stayed stuck in "Running" forever and the real failure cause was masked. All error handling now normalises the error value first, so a failed job is correctly recorded as "Failed" with the real message (the scheduled-run path had the same flaw and was fixed too)
- **Fix scheduler potentially halting all job execution** -- a concurrency slot was acquired before the run-log INSERT, so if that write failed (DB busy, locked, disk full) the slot was never released; once this reached the concurrency cap the scheduler deadlocked and ran no further jobs until restart. Slot handling is now inside a `try/finally` so it is always released
- **Fix disabled/deleted jobs rescheduling themselves mid-run** -- a job was re-armed unconditionally after running, even if it had been disabled or deleted while running. It now reschedules only if the job still exists and is enabled
- **Fix connection leak when requesting a login code fails** -- if `sendCode` failed while requesting a code (invalid/blocked number, flood-wait), the connected Telegram client was orphaned and never destroyed. It is now destroyed on failure
- **Fix request hanging when importing a corrupted backup** -- a throw inside the import transaction escaped as an unhandled rejection and the request never responded. It now returns a clear error, and account import and template bulk-create are transactional so a mid-way failure rolls back rather than leaving partial data
- **Fix editing an account that uses default API credentials corrupting its API ID** -- editing such an account (empty `api_id`) stored the API ID as `0`. The original value is now preserved

---

## v0.9.33

### 中文

**修复**
- **修复模板无法新建（Issue #19）** -- `job_templates` 表的 `run_every_days` 字段迁移（ALTER）被错误地排在建表（CREATE）之前，全新安装首次启动时该迁移因表尚不存在而静默失败，导致建表时缺少此字段，新建模板报错 "table job_templates has no column named run_every_days"，且需重启容器才会自愈。现将该字段直接写入建表语句，并把兼容旧库的迁移移到建表之后，首次启动即正确
- **修复任务失败后卡在"运行中"且无法清除（Issue #18）** -- 升级或重启时若正好有任务在运行，其进程随之消失，但日志记录会永久停留在"运行中"状态：停止按钮找不到对应进程而失败，归档按钮又对运行中记录隐藏，导致该记录既停不掉也删不掉。现启动时会自动将残留的"运行中"记录标记为失败；对进程已不存在的卡住记录，点击停止会将其强制标记为失败以便清理

### English

**Fixes**
- **Fix templates failing to create (issue #19)** -- the `run_every_days` column migration (ALTER) for `job_templates` ran before the table's CREATE, so on a fresh install's first boot the ALTER silently failed (no table yet) and the table was created without the column, breaking template creation with "table job_templates has no column named run_every_days" until the container was restarted. The column is now part of the CREATE statement, and the upgrade-path ALTER moved after it, so it is correct from the first boot
- **Fix tasks stuck in "Running" after a failure, with no way to clear them (issue #18)** -- if a job was running during an upgrade or restart, its process vanished but the log row stayed "Running" forever: the stop button couldn't find the process and the archive button is hidden for running rows, so the entry could neither be stopped nor removed. Leftover "Running" rows are now automatically marked failed on startup, and for a stuck row whose process no longer exists, Stop force-marks it as failed so it can be cleared

---

## v0.9.32

### 中文

**修复**
- **修复推理模型导致 AI 返回空响应（Issue #17）** -- 签到验证码识别与 AI 选择按钮此前只给了 20/50 的极小 token 上限。DeepSeek、商汤等推理模型会先输出思维链，极小的 token 上限在模型给出答案前就被思维链耗尽，导致 content 返回为空并报"AI API returned an empty response"，而调试界面因默认 token 上限较大（5000）故一切正常。现任务侧统一改用更宽裕的 token 上限，并自动剥离模型内联的 `<think>` 思维链；当 token 上限仍不足以给出答案时，改为提示 token 被截断而非笼统的空响应错误

### English

**Fixes**
- **Fix reasoning models returning an empty AI response (issue #17)** -- captcha recognition and AI button selection used a tiny 20/50 token cap. Reasoning models (DeepSeek, SenseTime, etc.) emit chain-of-thought first, exhausting that tiny budget before producing an answer, so content came back empty with "AI API returned an empty response" -- while the debug interface kept working thanks to its larger default cap (5000). The task path now uses a generous token budget and strips inline `<think>` chain-of-thought; when the budget is still exhausted before an answer, the error names token truncation instead of a generic empty response

---

## v0.9.31

### 中文

**修复**
- **彻底修复内存持续增长问题（Issue #14）** -- v0.9.30 只处理了常驻的长连接客户端，但每次定时任务运行、任务重试、发送 TG 通知、检查账号状态以及各类认证操作都会临时创建一个 Telegram 客户端，用完后仅调用了 disconnect()。GramJS 的 disconnect() 不会停止客户端内部的心跳循环：该循环会把整个客户端对象永久固定在内存中，并且每 9 秒向一个不再被消费的发送队列追加一条 ping 请求，因此即使系统完全空闲，内存也会随任务运行次数累积而平滑增长。现所有临时客户端在用完后改用 destroy() 彻底销毁并释放内存
- **修复登录成功后可能因连接清理超时而报错** -- 提交验证码或 2FA 密码成功后，若清理临时连接时 GramJS 抛出超时错误，此前会导致本已成功的登录被误报为失败；现清理错误不再影响登录结果

### English

**Fixes**
- **Fully fix continued memory growth (issue #14)** -- v0.9.30 only covered the long-lived live clients, but every scheduled job run, retry, TG notification, account status check, and auth operation creates a short-lived Telegram client that was torn down with disconnect() only. GramJS's disconnect() does not stop the client's internal keepalive loop: the loop pins the whole client object in memory forever and appends a ping request every 9 seconds to a send queue nothing drains any more, so memory grew steadily with every job run even while the system was completely idle. All short-lived clients are now torn down with destroy(), fully releasing their memory
- **Fix a successful login occasionally reported as failed** -- after a successful code or 2FA submission, a GramJS timeout thrown while cleaning up the temporary connection could fail the already-successful login; cleanup errors no longer affect the login result

---

## v0.9.30

### 中文

**消息（Messenger）**
- **补全 Telegram 官方功能** -- 拉黑/取消拉黑联系人、举报（垂类原因 + 备注）、删除聊天（可选"为对方也删除"）、删除消息（含批量、"为对方也删除"）、编辑自己发送的消息、转发消息（含批量选择目标聊天）、多选模式（批量转发/删除）、输入中提示（收发双向，聊天列表与聊天头部均显示"对方正在输入…"）
- **举报用户/机器人时同步拉黑并删除聊天** -- 此前举报仅发送举报请求；现举报用户或机器人会同时拉黑对方并删除该聊天，对话框中会提示该行为，操作完成后聊天从列表中移除
- **修复删除聊天后重新出现** -- 删除聊天后刷新对话列表，该聊天此前会因本地缓存未清理而重新出现；现删除后立即从缓存中移除
- **群组/频道搜索大幅改进** -- 此前搜索主要依赖用户名匹配，常搜不到无用户名或非拉丁文标题的群组；现同时匹配本地已加入聊天的标题/用户名，并对已退出、已归档或无用户名的聊天做全局消息内容匹配，兼顾公开聊天的全局用户名匹配，结果按相关性排序；搜索时显示"正在搜索 Telegram…"、失败时给出提示而非静默失败，多词查询搜不到时自动去掉末尾词重试
- **加入群组失败提示更友好** -- 私有群组/频道、邀请链接已失效、已是群成员等场景均有明确文案；私有群加入失败时自动弹出"输入网址"对话框，方便直接粘贴邀请链接
- **移动端聊天头部按钮优化** -- 搜索、清空缓存、小程序模式、打开网址、关闭聊天等按钮在移动端合并为单个 ⋯ 菜单，避免挤占聊天名称显示空间；新增"跳转到最新消息"悬浮按钮，滚动离底部较远时出现，并显示未读消息数角标
- **清除缓存 / 清理账号** -- 消息视图头部新增两个按钮：**清除缓存**（清空该账号本地缓存并重新从 Telegram 拉取，用于排查显示异常）；**清理账号**（退出所有群组与频道、删除所有私聊记录、移除所有联系人及自定义文件夹，自动保留"收藏夹""Telegram 官方通知"和 SpamBot）；清理账号为不可逆操作，需在确认框中勾选"已核对账号名称并了解此操作不可撤销"后才能执行，完成后显示处理结果（成功/失败数量）
- **打开非 Telegram 链接改为可选择** -- 点击站外链接时弹出选择卡片，可选"在 Bemby 中打开"或"在浏览器中打开"；在 Bemby 中打开前会先探测目标网站是否允许被嵌入 iframe，不允许时自动改走内置代理加载，并在页面上方显示"该网站禁止嵌入，已通过 Bemby 代理加载，登录及部分交互功能可能无法使用"提示；代理加载的页面运行在隔离的沙箱环境中，无法访问 Bemby 自身的登录凭据
- **修复机器人编辑消息回复漏检问题** -- 签到与自定义任务中点击按钮后，若机器人是通过编辑已有消息（而非发送新消息）来更新按钮，此前可能被漏检导致任务超时失败；现同时监听消息编辑与新消息两种更新方式，并修复发送指令与开始监听之间的极短时间窗口导致回复丢失的问题，成功/失败关键字匹配也改为综合所有收到的回复消息判断

**AI**
- **修复不同服务商提供同名模型时默认模型可能用错凭据** -- 此前默认模型仅按模型名称匹配，当两个服务商提供同名模型（如同一模型换了服务商）时，系统会任选其中一个有效凭据的服务商，可能并非用户实际选择的那个；现默认模型改为精确锁定到具体的"服务商 + 模型"记录，设置页下拉选项据此区分显示；服务商或模型被删除时会自动清理失效的默认模型指向

**账户**
- **账户列表显示所属国家及国旗** -- 账户列表手机号下方新增一行，显示根据号码国家代码解析出的国旗与国家名称（悬停查看完整名称），名称随界面语言自动切换
- **新增/编辑账户表单校验** -- 名称与手机号现为必填项；未配置全局默认 API 凭据时，API ID 与 API Hash 也为必填项；已知的后端报错信息改为可读的中/英文提示

**列表、筛选与分页**
- **账户、任务、日志、模板列表改为服务端分页与筛选** -- 支持大数据量下的分页浏览，账户与模板新增搜索框（模板搜索支持模糊匹配并按相关度排序），日志新增状态筛选（全部/成功/失败/运行中），任务筛选下拉选项覆盖全部数据而非仅当前页；分页控件移至表格上方，页码/每页数量随刷新自动恢复

### English

**Messenger**
- **Fill out official Telegram feature parity** -- block/unblock a contact, report (with a reason and optional comment), delete a chat (with an optional "also delete for them"), delete messages (single or bulk, with the same revoke option), edit your own sent messages, forward messages (single or bulk, picking a destination chat), multi-select mode for bulk forward/delete, and typing indicators in both directions ("X is typing…" shown in the dialog list and the open chat header)
- **Reporting a user/bot now also blocks and deletes the chat** -- previously report only filed the report; reporting a user or bot now blocks them and deletes the chat in the same action, with the confirmation card calling this out, and the chat disappears from the list once done
- **Fix deleted chats reappearing** -- deleting a chat and then refreshing the dialog list could bring it back because the local cache wasn't pruned; it's now removed from the cache immediately on delete
- **Much better group/channel search** -- search previously relied mostly on username matching and often missed groups without a username or with non-Latin titles; it now matches your own chats by title or username locally, plus a global content search for chats you've left, archived, or that have no username, and a global username search for public chats, all ranked by relevance; shows a "Searching Telegram…" spinner, surfaces errors instead of failing silently, and retries multi-word queries by dropping trailing words when nothing matches
- **Friendlier join-group failures** -- clear messages for private groups/channels, expired invite links, and already-being-a-member; a failed private-group join now auto-opens the "Go to URL" dialog so you can paste the invite link directly
- **Mobile chat header cleanup** -- search, clear cache, mini app mode, open URL, and close chat collapse into a single ⋯ menu on mobile so the chat name keeps its space; a new floating "jump to latest" button appears once you've scrolled away from the bottom, with an unseen-message count badge
- **Clear cache / Clean account** -- two new buttons in the Messenger header: **Clear cache** wipes the account's local cache and refetches everything from Telegram (useful when something looks stale or wrong); **Clean account** leaves every group and channel, deletes every private chat history, and removes all contacts and custom folders (Saved Messages, the official Telegram service chat, and SpamBot are always kept); it's irreversible, so it requires ticking "I checked the account names above and understand this is irreversible" before it can run, and reports how many items succeeded or failed afterwards
- **Opening non-Telegram links now asks first** -- clicking an external link shows a chooser card with "Open in Bemby" or "Open in browser"; choosing Bemby first checks whether the target site allows being embedded, and if it doesn't, loads it through a built-in proxy instead with a banner noting "This site blocks embedding, so it was loaded via the Bemby proxy — sign-ins and some interactive features may not work"; proxied pages run in an isolated sandbox that cannot reach Bemby's own login credentials
- **Fix missed bot replies delivered as message edits** -- when a bot updates its buttons by editing its existing message rather than sending a new one, check-in and custom jobs could previously miss the update and time out; both edit and new-message updates are now watched, a short gap between sending a command and starting to listen no longer drops a fast reply, and success/failure text matching now considers every reply received rather than just one message

**AI**
- **Fix the default model sometimes running against the wrong provider's credentials** -- the default model was previously matched by name only, so when two providers offered a model with the same name, the app could pick either one's credentials rather than the one you actually selected; the default is now pinned to the exact provider + model combination, shown as distinct options in Settings, and automatically cleared if that provider or model is later removed

**Accounts**
- **Show each account's country and flag** -- the phone number column in the Accounts list now shows a flag and country name resolved from the number's calling code (full name on hover), localised to the active UI language
- **Add/edit account form validation** -- name and phone number are now required; API ID and API Hash are required too unless a global default is configured; known backend errors now show a readable message instead of raw text

**Lists, filtering & pagination**
- **Accounts, Jobs, Logs, and Templates move to server-side pagination and filtering** -- these lists now page through large datasets instead of loading everything at once; Accounts and Templates gain a search box (Templates search is fuzzy-matched and relevance-ranked), Logs gains a status filter (all / success / failed / running), and the Jobs filter dropdown now covers the whole dataset rather than just the loaded page; the pagination bar moved to the top of each table, and page/size selections persist across refreshes

---

## v0.9.29-patch-1

### 中文

- **修复 AI 功能在界面中被错误禁用** -- 任务与模板编辑器中的「{aiBtn}（AI 识别）」「{aiInput}」及「输入验证码」选项在密钥已配置的情况下仍显示"未配置密钥"并被禁用；原因是 AI 密钥已迁移至「AI 服务商」，且 v0.9.29 起旧版 `ai_api_key` 设置不再返回给前端，而界面仍依据该旧设置判断密钥是否存在；现设置接口返回服务端计算的 `ai_key_configured` 标志（依次检查 AI 服务商、旧版设置及 `AI_API_KEY` 环境变量），界面据此判断
- **修复升级安装中 AI 密钥回退失效** -- 从旧版本升级时会以旧版设置的内容播种默认 AI 服务商；若密钥当时仅通过 `AI_API_KEY` 环境变量提供，播种出的服务商密钥为空，且运行时不再回退到环境变量，导致 AI 调用报"密钥未配置"；现服务商密钥为空时会正确回退到旧版设置或环境变量

### English

- **Fix AI features wrongly disabled in the UI** -- the "{aiBtn} (AI recognition)", "{aiInput}" and "enter captcha" options in the job and template editors showed "no API key" and stayed disabled even when a key was configured; the AI key moved to AI Suppliers, and since v0.9.29 the legacy `ai_api_key` setting is no longer sent to the client, yet the UI still read that legacy setting to decide whether a key exists; the settings endpoint now returns a server-computed `ai_key_configured` flag (checking AI suppliers, then the legacy setting, then the `AI_API_KEY` env var) which the UI uses instead
- **Fix AI key fallback on upgraded installs** -- upgrading seeds the default AI supplier from the legacy setting; when the key was only ever provided via the `AI_API_KEY` env var, the seeded supplier ended up with an empty key and the runtime no longer fell back to the env var, so AI calls failed with "key not configured"; an empty supplier key now correctly falls back to the legacy setting or the env var

---

## v0.9.29

### 中文

**安全**
- **修复 WebSocket 鉴权绕过（严重）** -- 消息 WebSocket 此前只校验令牌签名，未校验令牌类型，导致公开的验证码令牌（由无需登录的 /api/auth/captcha 签发，使用同一密钥）可用于连接并读取任意账号的实时 Telegram 消息流；现 WebSocket 与 HTTP 接口共用同一套会话令牌校验，并同样强制"必须修改默认密码"
- **拒绝使用默认 JWT 密钥启动（严重）** -- 应用启动时若 JWT_SECRET 为空或仍为公开的占位默认值（如 change-me-in-production）将直接退出；docker-compose 与 env.example 不再提供可用的默认密钥，请用 `openssl rand -hex 32` 生成后设置（升级须知：未设置 JWT_SECRET 的部署需补上该变量方可启动）
- **新增安全响应头与统一错误处理** -- 增加 X-Frame-Options、X-Content-Type-Options、Referrer-Policy、CSP frame-ancestors 及生产环境 HSTS；新增全局错误处理，生产环境不再向客户端泄露堆栈信息（镜像已设置 NODE_ENV=production）
- **容器以非 root 用户运行** -- 通过 su-exec 入口脚本在修正数据目录属主后降权至 node 用户，绑定挂载的现有部署无需手动调整
- **导出加密覆盖更多凭据** -- 当任务/模板配置中含 Emby 用户名或密码时，导出强制加密；账号导出在仅有 API Hash（无会话字符串）时也强制加密
- **其他加固** -- 隐藏遗留的 ai_api_key 设置，不再返回给前端；对自动抢注日志中来自机器人消息的内容进行 HTML 转义；为验证码令牌校验固定 HS256 算法

**调度与任务**
- **任务错峰调度** -- 多个任务随机到同一分钟执行会因高并发导致卡顿甚至失败（#10）；现调度器会自动错开各任务的运行时间，保证彼此至少间隔可配置的分钟数（设置 → 任务错峰，默认 2 分钟，0 表示关闭）；窗口过窄无法满足间隔时自动退化为尽量分散且不重复同一分钟
- **任务并发上限** -- 同一时刻最多并发执行 2 个任务，超出的任务自动排队依次执行，避免偶发的同时触发造成拥塞
- **修复手动运行未回退全局 TG API 凭据** -- 依赖全局默认 API 凭据的账号此前只有定时任务能正常运行，「立即运行」会因缺少凭据而失败；现手动运行与调度器行为一致，无可用凭据时返回明确错误提示（采纳自 #9）
- **API 凭据按整对解析** -- 账号凭据不完整（只填了 API ID 或只填了 Hash）时，此前可能将账号字段与全局默认值混搭导致认证失败；现凭据整对解析：账号凭据完整时用账号的，否则整体使用全局默认（采纳自 #9）
- **日志查询加固与索引** -- 日志列表接口校验 jobId 并将分页上限固定为 200；为 jobs 和 job_logs 新增数据库索引，日志量大时列表页更快；移除未使用的 miniapp 代理路由（采纳自 #9）
- **界面调整** -- 任务类型「自动注册」更名为「抢注」；设置页中「通用设置」与「Emby 观看默认值」卡片位置互换，常用设置更靠前

**构建 / 发布**
- **镜像同步发布至 GHCR** -- 发布流程在推送 Docker Hub 的同时，将同一多架构镜像（amd64/arm64）推送到 GitHub 容器仓库 `ghcr.io/liveinaus/bemby`，版本标签与频道别名（latest/beta/dev）保持一致；使用内置 `GITHUB_TOKEN` 鉴权，无需额外密钥

### English

**Security**
- **Fix WebSocket authentication bypass (critical)** -- the messenger WebSocket previously verified only the token signature, not its type, so the public captcha token (minted by the unauthenticated /api/auth/captcha with the same secret) could be used to connect and read any account's live Telegram message stream; the WebSocket now shares the same session-token validation as the HTTP API and enforces the default-password-change gate
- **Refuse to boot with a default JWT secret (critical)** -- the app now exits at startup if JWT_SECRET is empty or left at a publicly known placeholder (e.g. change-me-in-production); docker-compose and env.example no longer ship a usable default. Generate one with `openssl rand -hex 32` (upgrade note: deployments that never set JWT_SECRET must add it before the app will start)
- **Add security response headers and a non-leaking error handler** -- X-Frame-Options, X-Content-Type-Options, Referrer-Policy, a CSP frame-ancestors directive, and HSTS in production; a global error handler now hides stack traces from clients in production (the image sets NODE_ENV=production)
- **Run the container as a non-root user** -- an su-exec entrypoint fixes data-dir ownership as root then drops to the node user; existing bind-mount deployments need no manual change
- **Export encryption covers more credentials** -- exports are forced to encrypt when a job/template config embeds an Emby username or password, and the account export now forces encryption when an API hash is present even without a session string
- **Other hardening** -- the legacy ai_api_key setting is no longer returned to the client; bot-message-derived content in auto-registration logs is HTML-escaped before rendering; the captcha token verification pins the HS256 algorithm

**Scheduling & jobs**
- **Staggered job scheduling** -- jobs randomly landing on the same minute ran concurrently and often lagged or failed (#10); the scheduler now spaces jobs at least a configurable number of minutes apart (Settings → Job Staggering, default 2 minutes, 0 disables); when a window is too narrow to honour the gap it degrades gracefully, spreading jobs out without doubling up a minute
- **Job concurrency cap** -- at most 2 jobs execute simultaneously; any extras queue and run in turn, so coincidental overlaps no longer thunder the client
- **Fix manual runs not falling back to global TG API credentials** -- accounts relying on the global default credentials previously only worked on the schedule; "Run now" failed for lack of credentials. Manual runs now resolve credentials the same way the scheduler does, with a clear error when none are available (adopted from #9)
- **API credentials resolve as a pair** -- an incomplete account pair (only API ID or only Hash) could previously be mixed with global defaults, producing a mismatched pair that fails authentication; credentials now resolve atomically: the account's own pair when complete, otherwise the global pair (adopted from #9)
- **Log query hardening and indexes** -- the log list endpoint validates jobId and caps page size at 200; new database indexes on jobs and job_logs keep the log pages fast as history grows; removed the unused miniapp proxy route (adopted from #9)
- **UI tweaks** -- the auto-registration job type's Chinese label is renamed from 自动注册 to 抢注; the General Settings and Emby Watch Defaults cards on the Settings page swapped positions so the more commonly used settings appear first

**Build / release**
- **Images also published to GHCR** -- the release workflow now pushes the same multi-arch image (amd64/arm64) to the GitHub Container Registry `ghcr.io/liveinaus/bemby` alongside Docker Hub, with matching version tags and channel aliases (latest/beta/dev); it authenticates with the built-in `GITHUB_TOKEN`, so no extra secret is required

---

## v0.9.28-patch-1

### 中文

- **修复 Emby 观看任务「上报前校验可播放」误判媒体离线** -- 部分服务器以反向代理分流媒体流量，仅支持 PlaybackInfo 返回的 `DirectStreamUrl` 形式（重定向至专用流媒体主机），对通用 `/Videos/{id}/stream` 探测请求直接返回错误，导致校验误判媒体离线、任务失败；现改为与真实播放器行为一致：先调用 PlaybackInfo 并探测其返回的 `DirectStreamUrl`（或 `TranscodingUrl`），失败时再回退到原有静态流地址，磁盘离线检测能力保持不变
- **清理 DeviceId 中的空格** -- 设备名称含空格（如 `Macbook Pro`）时，部分流媒体代理在生成签名重定向地址时会因空格解析失败，导致播放请求出错；现 DeviceId 中的空白字符统一替换为连字符（显示用的设备名称保持原样）

### English

- **Fix Emby watch "verify playable" wrongly reporting media offline** -- servers that front Emby with a stream-offloading reverse proxy only route the `DirectStreamUrl` form returned by PlaybackInfo (redirecting to a dedicated stream host) and reject the generic `/Videos/{id}/stream` probe, so verification wrongly reported media as offline and the job failed; the probe now matches real player behaviour by calling PlaybackInfo and fetching the returned `DirectStreamUrl` (or `TranscodingUrl`) first, falling back to the static stream URL, with disk-offline detection unchanged
- **Sanitise whitespace in DeviceId** -- device names containing spaces (e.g. `Macbook Pro`) broke signed stream redirects on some proxies, failing playback requests; whitespace in the DeviceId is now replaced with hyphens (the display device name is unchanged)

---

## v0.9.28

### 中文

**安全**
- **默认密码强制修改** -- 使用默认密码（`changeme`）登录时，全屏弹窗强制更改密码后方可访问其他页面；JWT 携带 `requirePasswordChange` 标识，未更改前所有 API 请求均返回 403
- **TRUST_PROXY 环境变量** -- 新增 `TRUST_PROXY` 环境变量，用于配置反向代理跳数（如 `1` 表示 nginx/Caddy）；正确设置后 IP 检测与速率限制方可在代理后正常工作
- **WebSocket 鉴权优化** -- 消息客户端 WebSocket 改为首条消息发送鉴权令牌，不再通过 URL 参数传递，避免令牌出现在访问日志中

**账户**
- **TG 账户安全管理** -- 账户编辑面板新增"高级"选项卡，包含：
  - **2FA 密码管理** -- 设置、修改或移除 Telegram 账户的两步验证密码
  - **会话管理** -- 查看所有活跃登录设备（含应用名称、IP、国家、最后活跃时间），可单独终止某个会话或一键终止所有其他设备
  - **恢复邮箱管理** -- 查看（含完整邮箱地址）、设置、更改或移除 Telegram 2FA 恢复邮箱；变更操作均需输入当前 2FA 密码，设置新邮箱时提供完整的邮件确认流程（含重新发送和取消待确认）
  - **通行密钥管理** -- 查看已注册的通行密钥（Passkeys）列表（含名称、添加与最近使用时间）并可移除
- **账户备注** -- 可在账户编辑面板的基本信息选项卡中添加自由文本备注；表格中的备注列可通过"显示/隐藏备注"按钮切换显示（移动端始终隐藏）；支持在勾选多个账户后批量设置备注
- **账户备份加密** -- 导出会话文件时可设置自定义密码加密；导入时自动检测加密状态并提示输入密码；"强制重新认证"选项（推荐）可在导入时清除会话令牌，避免同一令牌被多设备共用导致 Telegram 撤销
- **更新 Telegram 个人资料** -- 在账户编辑面板的"个人资料"选项卡中直接修改该 Telegram 账户的名字、姓氏和简介
- **按名称引用账户** -- 设置中新增开关，开启后消息、任务、模板等引用账户处将以「Bemby 账户名 - TG 账号名」形式显示；账户列表新增 TG 账号列，显示 Telegram 显示名称与用户名（存储于数据库，首次访问自动获取，可手动刷新）
- **设备名称变量** -- TG 应用客户端的设备型号支持 `{name}`、`{tgName}`、`{tgUsername}`、`{id}` 以及随机 `{word:4}`、`{num:4}`、`{alpha:8}`、`{uuid}` 变量，随机值按账户固定，仅在修改模板时重新生成，使每个账户拥有唯一的设备名称

**消息客户端**
- **消息独立视图** -- 消息客户端由弹窗改为独立页面视图，空间更充裕，体验更流畅
- **发送文件与图片** -- 可在聊天中附加并发送图片和任意文件，图片支持"以文件方式发送"选项
- **静音 / 取消静音** -- 右键菜单支持静音 8 小时、1 周、永久静音和取消静音；已静音对话在列表中显示静音徽标
- **加入文件夹** -- 右键菜单可将对话添加至 Telegram 文件夹
- **编辑联系人** -- 在个人资料面板中直接修改联系人姓名（支持名和姓）
- **表情包显示** -- 贴纸消息以图片形式正确显示，不再识别为文件
- **小程序显示模式切换** -- 工具栏新增拼图图标按钮，可在"应用内打开"和"浏览器打开" Telegram 小程序之间切换
- **打开网址对话框** -- 工具栏新增地球图标按钮，支持粘贴任意 URL 或 t.me 链接，直接在消息客户端或浏览器中打开
- **简介链接化** -- 个人资料面板中的简介文本，URL 和 @用户名可点击跳转
- **修复 IME 输入误发** -- 使用中文/日文/韩文输入法时，合成中按下回车不再意外发送消息
- **修复已读状态显示** -- 已读消息正确显示双勾，未读消息显示单勾
- **机器人命令直接发送** -- 从命令菜单选择命令后立即发送，无需再次按回车
- **修复特殊字符发送** -- 含 Markdown 特殊字符（如 `__`）的消息现以纯文本发送，不再被误解析为格式标记

**任务**
- **批量运行任务** -- 在任务列表中勾选多个任务后，点击"运行 (N)"按钮可按顺序依次执行，支持自定义任务间延迟时间（默认 70 秒）
- **批量修改时间窗口** -- 勾选多个任务后可一键将其时间窗口批量修改为相同的开始/结束时间
- **按名称搜索任务** -- 任务列表新增名称搜索框，可快速筛选任务
- **归档任务** -- 任务改为"归档"而非直接删除，保留其历史日志；支持单个及批量归档
- **从日志重跑失败任务** -- 日志视图中可对失败的执行记录一键重新运行
- **新增自定义动作**
  - **加入群组 / 订阅频道** -- 支持公开用户名或私有邀请链接；订阅频道可先校验订阅状态、发送后再次验证；加入群组可选配"入群后点击验证按钮"
  - **向指定联系人发送消息 / 点击按钮** -- 可对流程中指定的机器人、群组或用户发送消息/命令，或点击其最近消息上的按钮
- **上报前校验可播放（Emby）** -- Emby 观看任务上报前先确认媒体文件可读取（磁盘在线），避免文件离线时上报虚假观看

**模板**
- **批量永久静音机器人** -- 在模板列表中勾选多个模板，点击"永久静音机器人"，将为所有关联 Telegram 账户一次性静音该机器人通知（内置速率限制保护，每次间隔 4 秒）

**设置**
- **默认 TG API 凭据** -- 在设置页面统一配置 API ID 和 API Hash，无独立凭据的账户自动使用全局默认值；API Hash 在界面中始终脱敏显示
- **AI 服务商自动切换** -- 新增开关，默认模型返回限速或其他 API 错误时，自动尝试其他已配置的服务商

**可靠性与 Bug 修复**
- **系统升级更稳健** -- 数据库迁移与升级流程增强，修复升级时账户被清空的问题，并新增完整的数据完整性测试
- **日志"加载更多"按钮消失** -- 点击一次后按钮不再消失，可持续加载更早记录
- **移动端输入框缩放** -- 修复 iOS 在点击输入框时自动放大页面的问题
- **底部导航栏** -- 修复底部导航栏在特定场景下不显示的问题
- **账户排序顺序** -- 修复拖拽排序偶发不正确的问题

### English

**Security**
- **Forced admin password change** -- logging in with the default password (`changeme`) now shows a full-screen modal requiring a password change before any other page is accessible; the JWT carries a `requirePasswordChange` claim that blocks all API calls until resolved
- **TRUST_PROXY env var** -- new `TRUST_PROXY` environment variable to configure the number of reverse proxy hops in front of the app (e.g. `1` for nginx/Caddy); required for rate limiting and IP detection to work correctly when behind a proxy
- **WebSocket auth handshake** -- the messenger WebSocket now authenticates via a first-message payload instead of a URL query parameter, keeping the token out of access logs

**Accounts**
- **Telegram account security management** -- account edit panel now has an Advanced tab with:
  - **2FA password management** -- set, change, or remove the two-factor authentication password on any Telegram account
  - **Session management** -- view all active login sessions (app name, IP, country, last active time) with per-session terminate and a one-click "terminate all others" button
  - **Recovery email management** -- view (including full address reveal), set, change, or remove the Telegram 2FA recovery email; all changes require the current 2FA password; a full confirmation code flow (with resend and cancel pending) handles new-address verification
  - **Passkey management** -- list registered WebAuthn passkeys (name, added and last-used times) and remove them
- **Account notes** -- add free-text notes per account from the Basic tab of the edit panel; the Notes column in the accounts table can be shown/hidden via a toggle button (always hidden on mobile); bulk-update notes across selected accounts at once
- **Encrypted account backup** -- account exports can be protected with a user-supplied password; imports auto-detect encryption and prompt for the key; a "Force re-auth" option (recommended) clears session tokens on import to avoid Telegram revoking a shared token
- **Update Telegram profile** -- edit the Telegram account's first name, last name, and bio directly from the Profile tab of the account edit panel
- **Refer to accounts by name** -- a new Settings toggle shows accounts as "{Bemby name} - {TG name}" across the messenger, jobs, and templates; a TG Name column shows each account's Telegram display name and username (stored in the database, auto-fetched on first visit, refreshable on demand)
- **Device name variables** -- the TG app client Device Model now supports `{name}`, `{tgName}`, `{tgUsername}`, `{id}`, and random `{word:4}`, `{num:4}`, `{alpha:8}`, `{uuid}` variables; random values stay fixed per account and only regenerate when the template changes, giving each account a unique device name

**Messenger**
- **Full-page messenger view** -- the messenger moved from a popup to a dedicated page view for more room and a smoother experience
- **Send files and images** -- attach and send images and arbitrary files in a chat; images offer a "send as file" option
- **Mute / unmute** -- context menu offers mute for 8 hours, 1 week, forever, or unmute; muted dialogs show a mute badge in the list
- **Add to folder** -- context menu option to add a chat to any Telegram folder
- **Edit contact** -- edit a contact's first and last name directly in the profile panel
- **Sticker support** -- sticker messages now display correctly as images instead of document attachments
- **Mini app display toggle** -- new puzzle-piece button in the toolbar switches between opening Telegram mini apps in-app (embedded panel) or in the browser
- **Open URL dialog** -- new globe button in the toolbar lets you paste any URL or t.me link and open it in the messenger or browser without leaving the app
- **Bio linkification** -- URLs and @mentions in profile bios are now clickable
- **Fix IME composition send** -- pressing Enter during CJK (Chinese/Japanese/Korean) IME composition no longer accidentally sends the message
- **Fix read status display** -- sent messages correctly show double-tick when read, single-tick when delivered
- **Bot command sends immediately** -- selecting a command from the autocomplete menu now sends it immediately; no need to press Enter again
- **Fix special character sending** -- messages containing Markdown special characters (e.g. `__`) are now sent as plain text and no longer misinterpreted as formatting

**Jobs**
- **Bulk run jobs** -- select multiple jobs and run them sequentially; a configurable delay between runs defaults to 70 seconds
- **Bulk change time window** -- select multiple jobs and set them all to the same start/end window in one action
- **Search jobs by name** -- a name filter box in the jobs list quickly narrows the list
- **Retire jobs** -- jobs are now retired (archived) instead of deleted, preserving their history logs; supports single and bulk retire
- **Rerun failed jobs** -- re-run a failed execution directly from the log view with one click
- **New custom actions**
  - **Join group / Subscribe to channel** -- accepts a public username or private invite link; channel subscribe can pre-check subscription status and re-verify after sending; join group optionally clicks a verification button after joining
  - **Send message / click button for a contact** -- send a message/command to, or click a button on the latest message from, a specific bot, group, or user named in the flow
- **Verify playable before reporting (Emby)** -- Emby Watch jobs confirm the media file is readable (disk online) before reporting, avoiding a fake watch when the file is offline

**Templates**
- **Bulk mute bot forever** -- select templates and mute the associated bot forever across all linked Telegram accounts in one action; built-in 4-second rate-limit protection between account calls

**Settings**
- **Default TG API credentials** -- set a global API ID and Hash in Settings; accounts without their own credentials fall back to these; the Hash is always masked in the UI
- **AI provider auto-fallback** -- new toggle that automatically tries other configured providers when the default model returns a rate-limit or other API error

**Reliability & Bug Fixes**
- **More robust system upgrade** -- hardened database migration and upgrade flow; fixed accounts being wiped on upgrade and added full data-integrity tests
- **Log "Load More" button** -- button no longer disappears after the first click; continues to appear while more records exist
- **Mobile input zoom** -- fixed iOS zooming in when tapping input fields
- **Bottom navigation bar** -- fixed the bottom nav bar not appearing in certain states
- **Account sort order** -- fixed an occasional incorrect sort order after drag-and-drop reordering

---

## v0.9.27-patch-1

### 中文

- **修复 Emby Watch 模板更新清除凭据的问题** -- 更新 Emby Watch 模板时，`syncLinkedJobs` 会将模板配置直接覆盖至关联任务，导致每个任务独立存储的 `username` 和 `password` 被清空；现已修复为按任务合并配置，模板级设置（如 `playDuration`、`markWatched`）正常同步，各任务凭据得以保留

### English

- **Fix Emby Watch template update clearing job credentials** -- updating an Emby Watch template caused `syncLinkedJobs` to overwrite each linked job's config with the raw template config, wiping the per-job `username` and `password`; fixed to merge config per-job so template-level settings (`playDuration`, `markWatched`, etc.) propagate while each job's credentials are preserved

---

## v0.9.27

### 中文

- **消息链接协议白名单** -- Telegram 消息中的 URL 在生成 `<a>` 标签前，现已校验协议白名单（仅允许 `http:`、`https:`、`tg:`）；其他协议（如 `javascript:`、`data:` 等）的链接将以纯文本渲染，不生成可点击链接，消除潜在的 XSS 风险

### English

- **URL protocol whitelist for message links** -- Telegram message URLs are now validated against a protocol whitelist (`http:`, `https:`, `tg:`) before being rendered as `<a>` tags; URLs with any other protocol (e.g. `javascript:`, `data:`) are rendered as plain text instead of clickable links, eliminating a potential XSS vector

---

## v0.9.25

### 中文

- **账号页面新增 TG 账号列** -- 账号列表新增"TG 账号"列，显示每个 Telegram 账号的显示名称和用户名；数据存储于数据库，首次访问时自动获取已认证账号的信息，可通过悬停显示的刷新按钮手动更新；移动端隐藏该列，刷新操作合并至 ⋯ 操作菜单；查看账号状态时同步更新数据库中的显示名称
- **消息客户端导航修复** -- 修复返回按钮和关闭按钮的导航问题；返回按钮现可正确跳转至历史记录中的上一个聊天；关闭 (X) 按钮无导航历史时正确取消选中当前聊天（显示空状态），移动端返回对话列表
- **滚动至顶部自动加载历史消息** -- 消息区域滚动至顶部时自动加载更早的消息，不再需要手动点击"加载更早消息"按钮；同时修复固定消息横幅遮挡该按钮的问题
- **头像加载队列优化** -- 头像改为按需逐个加载，最多 3 个并发请求；按用户 ID 缓存（跨账号共享），已缓存的头像不再重复请求

### English

- **TG Name column on Accounts page** -- a new "TG Name" column shows each account's Telegram display name and username; data is stored in the database, auto-fetched on first visit for authenticated accounts with no stored name, and refreshable on demand via a hover-revealed button; the column is hidden on mobile with a "TG Name" refresh option in the ⋯ action sheet; checking account status also updates the stored display name
- **Messenger back/close navigation fixed** -- the Back button now correctly navigates to the previous chat when history exists; the close (X) button deselects the current chat (shows empty state) when there is no navigation history, or navigates back if there is; on mobile Back still returns to the dialog list
- **Auto-load older messages on scroll** -- scrolling to the top of the messages area now automatically loads older messages, replacing the manual "Load older messages" button; also fixes the pinned message banner blocking that button
- **Avatar loading queue** -- avatars now load on demand one at a time with a maximum of 3 concurrent requests; cached by user ID and shared across all accounts so already-fetched avatars are never re-requested

---

## v0.9.24

### 中文

- **账号会话失效自动检测** -- 账号页面加载时自动检查所有已启用的认证账号；会话失效（AUTH_KEY_DUPLICATED、SESSION_REVOKED 等）时自动标记为"会话已失效"并显示重新认证按钮
- **强制重新认证** -- 编辑面板中新增"强制重新认证"按钮，可一键清除现有会话并重置认证状态，无需删除账号
- **账号拖拽排序** -- 支持在账号列表中通过拖拽手柄对账号进行排序，顺序持久化保存
- **TG 应用客户端随机模式** -- 设置页面新增"账号默认客户端"选项，可在"使用默认"和"随机选择"之间切换；随机模式下，无指定客户端的账号每次连接将从所有预设中随机挑选
- **代理徽章** -- 账号列表中使用代理的账号现显示紫色代理徽章（含代理名称）
- **认证验证码投递修复** -- 使用桌面端客户端预设（Linux、Windows、Mac）时，认证流程不再传递设备参数，避免 Telegram 将验证码路由至不存在的桌面会话；设备配置仅在会话建立后的实时连接中生效
- **内置邀请链接** -- 消息客户端中点击 `t.me/+HASH` 邀请链接时，将在应用内显示群组预览和加入确认对话框，而非跳转至浏览器

### English

- **Automatic session expiry detection** -- all enabled authenticated accounts are checked on the Accounts page load; sessions invalidated by AUTH_KEY_DUPLICATED, SESSION_REVOKED, and related errors are automatically marked as session_expired and a re-auth button is shown
- **Force re-auth** -- a Force Re-auth button in the account edit panel clears the existing session and resets auth status without deleting the account
- **Account drag-and-drop reordering** -- accounts can be reordered by dragging the grip handle; order is persisted
- **TG app client random mode** -- a new "Default client for accounts" toggle in Settings allows switching between a fixed default and random selection; in random mode, accounts with no explicit client pick one at random from all configured presets on each connection
- **Proxy badge** -- accounts using a proxy now show a purple badge with the proxy name inline in the accounts list
- **Auth code delivery fix** -- when a desktop client preset (Linux, Windows, Mac) is configured, device params are no longer passed during the auth code request phase; this prevents Telegram routing the code to a non-existent desktop session; the full device profile is applied only to the live session after authentication
- **In-app invite links** -- clicking a `t.me/+HASH` invite link in the built-in messenger now shows an in-app group preview and join confirmation dialog instead of opening in the browser

---

## v0.9.23

### 中文

- **内置 Telegram 消息客户端全面升级** -- 消息客户端现已支持表情回应、引用回复、内联图片查看、频道帖子评论/线程，以及机器人命令自动补全，并自动将已读消息标记为已读
- **表情回应** -- 将鼠标悬停在任意消息上，点击笑脸图标可选择表情；提供 👍 ❤️ 😂 😮 😢 👎 🔥 🎉 八个快捷表情；可再次点击取消已有回应；自己的回应会以高亮样式显示
- **引用回复** -- 将鼠标悬停在消息上，点击回复图标即可引用；消息框顶部显示引用预览；点击引用消息可滚动至原始消息；发送后原始引用关系在 Telegram 中完整保留
- **内联图片查看** -- 含图片的消息直接在聊天气泡中展示缩略图，无需跳转外部链接
- **频道帖子评论** -- 在带评论计数的频道消息下点击评论按钮，可在右侧面板中查看并回复评论线程
- **机器人命令自动补全** -- 与机器人对话时，输入框左侧出现 `/` 按钮，点击可展开命令列表；在输入框中输入 `/` 后也会自动弹出命令面板，每条命令附带说明；通过方向键或 Tab/Enter 选择，Escape 关闭
- **自动标记已读** -- 打开聊天窗口或收到新消息时，自动调用 Telegram API 标记消息已读，并清除对话列表中的未读角标
- **导航栏重新排序并添加图标** -- 导航菜单调整为：账户、消息、任务、模板、日志、设置、帮助；各菜单项均已添加 FontAwesome 图标

### English

- **Telegram Messenger major upgrade** -- the built-in messenger now supports emoji reactions, quoted replies, inline photo viewing, channel post comment threads, bot command autocomplete, and auto read-marking
- **Emoji reactions** -- hover any message and click the smiley icon to react; eight quick-pick emojis (👍 ❤️ 😂 😮 😢 👎 🔥 🎉) plus a full picker; tap your own reaction to remove it; your reactions are highlighted
- **Quoted replies** -- hover a message and click the reply icon to quote it; a preview strip appears above the compose box; click any reply quote to scroll to the original; the reply relationship is preserved on Telegram
- **Inline photo viewing** -- messages containing photos display the image directly inside the chat bubble
- **Channel post comments** -- click the comment count button on any channel post to open the thread panel and reply to comments
- **Bot command autocomplete** -- a `/` button appears beside the compose box when chatting with a bot; typing `/` in the input also opens the panel, showing each command with its description; navigate with arrow keys or Tab/Enter; Escape closes the panel
- **Auto read-marking** -- opening a chat or receiving a new message calls the Telegram API to mark messages as read and clears the unread badge on the dialog
- **Navigation reorder with icons** -- menu order is now: Accounts, Messages, Jobs, Templates, Logs, Settings, Help; each item has a FontAwesome icon

---

## v0.9.21

### 中文

- **代理支持扩展** -- 代理设置现已适用于所有任务类型（签到、自定义、Emby 观看）；可在模板中为任意类型设置代理，HTTP 代理用于 Emby 请求，SOCKS5 代理用于 Telegram 连接
- **修复 Emby 容器连接问题** -- 修复在 Docker 容器中 Emby 观看任务无法连接服务器的问题；无代理时恢复使用 Node.js 原生 fetch，避免 undici 在容器环境中的 TLS 兼容性问题

### English

- **Proxy support extended** -- proxy settings now apply to all job types (checkin, custom, Emby Watch); set a proxy on any template type, with HTTP proxies used for Emby requests and SOCKS5 proxies for Telegram connections
- **Fix Emby container connectivity** -- fixed Emby Watch jobs failing to reach the server when running in a Docker container; non-proxy requests now use Node.js native fetch instead of undici to avoid TLS compatibility differences in containerised environments

---

## v0.9.20

### 中文

- **批量操作** -- 任务和模板列表支持批量启用、禁用和删除；禁用和删除操作均有确认弹窗
- **禁用模板隐藏** -- 已禁用的模板不再出现在任务的模板下拉列表中；已绑定该模板的任务不受影响
- **Emby 错误信息增强** -- Emby 观看任务失败时，错误信息不再仅显示"fetch failed"，而是包含完整请求 URL 及底层原因（如 ECONNREFUSED）；HTTP 错误则显示状态码和 Emby 返回的错误正文
- **日志文本搜索** -- 日志页面新增文本搜索框，可对已加载的日志按任务名称、账号名称或消息内容进行模糊筛选；搜索状态在刷新后自动恢复

### English

- **Bulk actions** -- jobs and templates lists now support bulk enable, disable, and delete; disable and delete show confirmation modals
- **Disabled templates hidden** -- disabled templates no longer appear in the job template dropdown; jobs already linked to a disabled template are unaffected
- **Emby error enrichment** -- Emby Watch failures now show the full request URL and underlying cause (e.g. ECONNREFUSED) instead of "fetch failed"; HTTP errors include the status code and Emby's error body
- **Log text search** -- a search input in the Logs header filters loaded rows by job name, account name, or message; filter state persists across page refreshes

---

## v0.9.19

### 中文

- **模板单元测试** -- 新增模板 CRUD、模板同步至关联任务、删除级联、模板绑定与解绑、embywatch 配置锁例外以及运行时配置合并的后端单元测试

### English

- **Template unit tests** -- added backend unit tests covering template CRUD, sync to linked jobs, delete cascade, applying and removing templates, embywatch config-lock exception, and runtime config merge in the runner

---

## v0.9.18

### 中文

- **模板批量分享** — 在模板列表中勾选多行，点击页头的**分享所选 (N)** 按钮，将所有选中模板以 JSON 数组形式复制至剪贴板；导入也同时支持单个对象和数组
- **日志归档** — 点击日志行上的归档图标可软隐藏该记录（不删除数据）；归档记录默认隐藏，可通过**显示已移除**开关切换可见性；点击还原图标取消归档
- **禁用确认弹窗** — 在任务列表中点击启用状态标签禁用任务时，会弹出确认对话框；重新启用无需确认
- **下次运行面板排序** — 首页"下次运行"面板现按执行时间先后排序
- **默认时间窗口** — 新建任务的默认时间窗口调整为 10:00–22:00
- **设置页面布局优化** — 设置卡片改为自适应网格排列，减少空白浪费

### English

- **Multi-template share** — tick checkboxes on any template rows and click **Share Selected (N)** in the header to copy all selected templates as a JSON array to the clipboard; import now accepts both a single JSON object and an array
- **Log retirement** — click the archive icon on any non-running log row to soft-hide it without deleting data; archived records are hidden by default and revealed by the **Show Retired** toggle; click the restore icon to un-archive
- **Disable confirmation** — clicking the enabled badge on a job row to disable it now shows a confirmation modal; re-enabling is still immediate
- **Next-run panel sorting** — the "Next Scheduled" panel on the dashboard now sorts runs by time ascending
- **Default schedule window** — new jobs now default to a 10:00–22:00 window
- **Settings layout** — settings cards now flow in an adaptive grid, reducing wasted whitespace

---

## v0.9.17

### 中文

- **API 密钥脱敏** — AI 服务商 API 密钥在设置页面仅显示首尾各 4 位（如 `sk-a****1234`），防止密钥泄露

### English

- **API key masking** — AI supplier API keys are now masked in the Settings UI, showing only the first and last 4 characters (e.g. `sk-a****1234`) to prevent accidental key exposure
