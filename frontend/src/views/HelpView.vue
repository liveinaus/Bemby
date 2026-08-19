<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ locale === "zh" ? "帮助" : "Help" }}</h2>
    </div>

    <div
      style="display: flex; flex-direction: column; gap: 20px; max-width: 740px"
    >
      <!-- Overview -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">概览</div>
            <p class="help-para">
              Bemby 自动执行三类任务：Telegram 机器人签到（签到）、Emby
              视频观看会话和自定义多步骤流程。
              任务按照可配置的时间窗口每日定时运行。一般流程如下：
            </p>
            <ol class="help-steps">
              <li>
                在"账户"页面添加并认证一个 <strong>Telegram 账户</strong>。
              </li>
              <li>创建一个<strong>任务</strong>，关联该账户并配置运行计划。</li>
              <li>调度器每天在时间窗口内随机选择一个时间点自动执行任务。</li>
              <li>查看<strong>日志</strong>以确认结果或排查问题。</li>
            </ol>
            <p class="help-note">
              筛选条件、列排序方式和上次访问的页面在刷新或重新登录后自动恢复。
            </p>
            <p class="help-note">
              Telegram 连接按需建立：任务运行结束后立即释放；消息页面的实时连接在闲置
              30 分钟后自动断开并释放内存，再次使用时自动重连，无需任何操作。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Overview</div>
            <p class="help-para">
              Bemby automates three types of tasks: Telegram bot check-ins
              (签到), Emby video-watch sessions, and custom multi-step bot
              flows. Jobs run on a daily schedule within a configurable time
              window. The general workflow is:
            </p>
            <ol class="help-steps">
              <li>
                Add and authenticate a <strong>Telegram account</strong> under
                Accounts.
              </li>
              <li>
                Create a <strong>Job</strong>, link it to that account, and
                configure its schedule.
              </li>
              <li>
                The scheduler picks a random time within the window each day and
                runs the job automatically.
              </li>
              <li>
                Check <strong>Logs</strong> to verify results or diagnose
                failures.
              </li>
            </ol>
            <p class="help-note">
              Filter selections, column sort order, and last visited page are
              automatically restored on refresh or re-login.
            </p>
            <p class="help-note">
              Telegram connections are created on demand: job connections are
              released as soon as the run finishes, and the Messenger's live
              connection disconnects automatically after 30 minutes of
              inactivity to free memory, reconnecting seamlessly on next use.
            </p>
          </template>
        </div>
      </div>

      <!-- Accounts -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">账户</div>
            <p class="help-para">
              账户代表 Telegram 用户会话。每个签到任务需要一个已认证的账户。
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>API ID / API Hash</td>
                  <td>
                    在 <code>my.telegram.org</code> 的"API development
                    tools"中获取。<span v-if="dataStoreEnabled"
                      >也可以在【模板 → 添加模板】中选择内置模板"获取 Telegram
                      API ID / Hash"，由内置浏览器登录
                      <code>my.telegram.org</code>
                      并自动写回账户（登录验证码由该账户在 Telegram
                      中接收）。</span
                    >
                  </td>
                </tr>
                <tr>
                  <td>发送验证码</td>
                  <td>通过 Telegram 向账户手机号发送登录验证码。</td>
                </tr>
                <tr>
                  <td>验证</td>
                  <td>
                    输入收到的验证码。若启用了二步验证，请在提示时输入 2FA
                    密码。
                  </td>
                </tr>
                <tr>
                  <td>拖拽排序</td>
                  <td>
                    点击账户行左侧的拖拽手柄并拖动，可对账户列表进行排序，顺序持久保存。
                  </td>
                </tr>
                <tr>
                  <td>列排序</td>
                  <td>
                    点击名称、手机号、状态或添加时间列标题按该列排序：升序 →
                    降序 →
                    恢复手动拖拽顺序，排序状态跨刷新保留。排序或搜索状态下会停用拖拽排序，因为对筛选后的子集重排容易产生误解。
                  </td>
                </tr>
                <tr>
                  <td>强制重新认证</td>
                  <td>
                    在编辑面板中点击"强制重新认证"，可清除现有会话并重置为未认证状态。
                  </td>
                </tr>
                <tr>
                  <td>2FA 密码</td>
                  <td>
                    在账户编辑面板的<strong>高级</strong>选项卡中设置、修改或移除 Telegram 两步验证密码。
                  </td>
                </tr>
                <tr>
                  <td>会话管理</td>
                  <td>
                    在<strong>高级</strong>选项卡中查看所有活跃登录设备（含应用名称、IP、国家、最后活跃时间），可单独终止某个会话或一键终止所有其他设备。
                  </td>
                </tr>
                <tr>
                  <td>加密导出 / 导入</td>
                  <td>
                    导出账户备份时可设置密码加密；导入时自动识别加密状态并提示输入密码。勾选<strong>强制重新认证</strong>（推荐）可在导入时清除会话令牌，避免 Telegram 因令牌共用而撤销会话。
                  </td>
                </tr>
                <tr>
                  <td>备注</td>
                  <td>
                    可在账户编辑面板的<strong>基本信息</strong>选项卡中为账户添加备注。表格中的备注列可通过页面顶部的"显示备注 / 隐藏备注"按钮切换显示（移动端始终隐藏）。勾选多个账户后点击"设置备注 (N)"可批量更新备注。
                  </td>
                </tr>
                <tr>
                  <td>恢复邮箱</td>
                  <td>
                    在<strong>高级</strong>选项卡中查看、设置、更改或移除 Telegram 账户的 2FA 恢复邮箱。查看完整邮箱地址或变更操作均需输入当前 2FA 密码；设置新邮箱时，Telegram 会向该地址发送确认码，输入后方可生效。
                  </td>
                </tr>
                <tr>
                  <td>个人资料</td>
                  <td>
                    在账户编辑面板的<strong>个人资料</strong>选项卡中直接修改该 Telegram 账户的名字、姓氏和简介。
                  </td>
                </tr>
                <tr>
                  <td>通行密钥（Passkeys）</td>
                  <td>
                    在<strong>高级</strong>选项卡中查看已注册的通行密钥（WebAuthn，含名称、添加与最近使用时间）、<strong>添加通行密钥</strong>（整个注册流程在服务端完成，每账户一个）、<strong>验证</strong>（确认 Telegram 仍接受该密钥）并可移除。已添加通行密钥的账户，登录对话框会出现<strong>使用通行密钥登录</strong>：先以通行密钥登录，随后仅需输入 2FA 密码。（实验性功能）
                  </td>
                </tr>
                <tr>
                  <td>额外信息列</td>
                  <td>
                    通过页面顶部的"显示额外信息 / 隐藏额外信息"按钮切换<strong>额外信息</strong>列，展示登录邮箱、受限状态、通行密钥标记等属性。勾选账户后可点击"获取属性"批量刷新。
                  </td>
                </tr>
                <tr>
                  <td>Shift 范围选择</td>
                  <td>
                    在账户表格中按住 Shift 点击，可选中上次点击行与本次点击行之间的连续区间。
                  </td>
                </tr>
                <tr>
                  <td>批量操作</td>
                  <td>
                    勾选多个账户后，操作收纳于<strong>批量操作</strong>菜单，各顺序操作共用"每个账户之间的间隔（秒）"以避免限流：<strong>批量重命名</strong>（按 <code>{index}</code> 递增序号，可补零、实时预览）、<strong>获取属性</strong>、<strong>批量修改登录邮箱</strong>（Gmail 别名地址（<code>+</code> 标签模板 + 变量），经 IMAP 读取确认码，应用专用密码仅用于本次运行且不存储，开始前需"测试登录"<span v-if="msApiAvailable">；也可从已配置的 msOauth2api 邮箱池为每个账户领取独立邮箱，失败时自动归还</span>。注意 Telegram 只能替换已有的登录邮箱、无法新增，未绑定邮箱的账户会失败）、<strong>批量修改凭据</strong>（设置/轮换 2FA 密码，可选移除其他设备/其他通行密钥）、<strong>批量添加通行密钥</strong>、<strong>批量设置隐私</strong>（逐项选择可见范围：无人 / 我的联系人 / 所有人，覆盖电话号码、最后上线、头像、简介、生日、转发署名、来电、礼物展示等，默认全部为“无人”；改成“所有人”即可恢复公开，之前隐藏的头像可以从同一界面放回来。Telegram 不允许“无人”的两项（“谁能通过号码找到我”“谁能把我加入群组”）最紧只能到“我的联系人”，Premium 专属项（如语音消息）不在此列）、<strong>批量修改资料</strong>（批量设置 Telegram 名字/姓氏/简介，每行对应一个账户、字段用制表符 Tab 分隔，可从表格直接粘贴，点击"生成随机名字"自动填充，或点击"AI 生成资料"按要求生成（例如"中国用户，简介用中文"，一次请求覆盖全部账户，可勾选"不生成简介"只生成名字；结果自动清理为单行、不含制表符并符合 Telegram 的长度上限）；作为后台批量任务运行，页面刷新不中断，失败账户自动重试）。设置环境变量 <code>BULK_ACCOUNT_MANAGEMENT=1</code> 后还提供<strong>批量添加账户</strong>（每行 <code>手机号----API网址</code>，自动创建并从各 API 网页读取验证码/2FA 完成认证）与<strong>批量清理</strong>。所有批量操作都在服务器上按顺序执行，开始后可以关闭弹窗甚至整个页面；进度在右下角的<strong>后台任务</strong>面板中查看（也可重新打开对应弹窗查看），并可随时<strong>终止</strong>——当前账户处理完即停止，其余标记为已终止。
                  </td>
                </tr>
                <tr>
                  <td>国家 / 国旗</td>
                  <td>
                    根据手机号的国家代码自动解析所属国家，在手机号下方显示国旗与国家名称，悬停可查看完整名称。
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="help-badges-row">
              <span class="badge badge-grey">未认证</span>
              <span class="badge badge-orange">等待验证码 / 二步验证</span>
              <span class="badge badge-green">已认证</span>
              <span class="badge badge-red">会话已失效</span>
              <span class="badge badge-purple"
                ><i
                  class="fa-solid fa-shield-halved"
                  style="margin-right: 3px"
                ></i
                >代理名称</span
              >
            </div>
            <p class="help-note">
              只有已认证的账户才能运行签到任务。账号页面加载时会自动检查所有已启用账户的会话状态，失效会话将自动标记为"会话已失效"。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Accounts</div>
            <p class="help-para">
              Accounts represent Telegram user sessions. Each check-in job
              requires one authenticated account.
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>API ID / API Hash</td>
                  <td>
                    Obtain from <code>my.telegram.org</code> under "API
                    development tools".<span v-if="dataStoreEnabled">
                      Or add a template from the built-in "Fetch Telegram API ID
                      / hash" preset: the built-in browser signs in to
                      <code>my.telegram.org</code> as the account, reads the
                      login code off Telegram, and writes the pair back onto the
                      account.</span
                    >
                  </td>
                </tr>
                <tr>
                  <td>Request Code</td>
                  <td>
                    Sends a login code to the account's phone number via
                    Telegram.
                  </td>
                </tr>
                <tr>
                  <td>Verify</td>
                  <td>
                    Enter the code received. If two-factor auth is enabled,
                    enter the 2FA password when prompted.
                  </td>
                </tr>
                <tr>
                  <td>Drag to reorder</td>
                  <td>
                    Drag the grip handle on any account row to reorder the list;
                    the order is persisted.
                  </td>
                </tr>
                <tr>
                  <td>Column sort</td>
                  <td>
                    Click the Name, Phone, Status, or Added column header to sort
                    by it: ascending → descending → back to the manual drag
                    order. The choice is remembered across refreshes. Drag
                    reordering is disabled while sorting or searching, since
                    reordering a filtered subset is misleading.
                  </td>
                </tr>
                <tr>
                  <td>Force re-auth</td>
                  <td>
                    The Force Re-auth button in the edit panel clears the
                    existing session and resets the account to unauthenticated
                    without deleting it.
                  </td>
                </tr>
                <tr>
                  <td>2FA password</td>
                  <td>
                    Set, change, or remove the two-factor authentication
                    password on any Telegram account from the
                    <strong>Advanced</strong> tab in the account edit panel.
                  </td>
                </tr>
                <tr>
                  <td>Session management</td>
                  <td>
                    The <strong>Advanced</strong> tab lists all active login
                    sessions (app, IP, country, last-active time). Terminate
                    individual sessions or all other sessions at once.
                  </td>
                </tr>
                <tr>
                  <td>Encrypted export / import</td>
                  <td>
                    Account exports can be password-protected; imports
                    auto-detect encryption and prompt for the key. Enable
                    <strong>Force re-auth</strong> (recommended) to clear
                    session tokens on import and prevent Telegram from revoking
                    a shared token.
                  </td>
                </tr>
                <tr>
                  <td>Notes</td>
                  <td>
                    Add free-text notes per account from the
                    <strong>Basic</strong> tab of the edit panel. The Notes
                    column in the table can be toggled on/off via the
                    Show/Hide Notes button (always hidden on mobile). Select
                    multiple accounts and click <strong>Set Notes (N)</strong>
                    to bulk-update notes at once.
                  </td>
                </tr>
                <tr>
                  <td>Recovery email</td>
                  <td>
                    View, set, change, or remove the 2FA recovery email from
                    the <strong>Advanced</strong> tab. Revealing the full
                    address or making changes requires the current 2FA password.
                    When setting a new email, Telegram sends a confirmation code
                    to that address; enter the code to complete the change.
                  </td>
                </tr>
                <tr>
                  <td>Profile</td>
                  <td>
                    Edit the Telegram account's first name, last name, and bio
                    directly from the <strong>Profile</strong> tab in the account
                    edit panel.
                  </td>
                </tr>
                <tr>
                  <td>Passkeys</td>
                  <td>
                    From the <strong>Advanced</strong> tab, list registered
                    WebAuthn passkeys (name, added and last-used times),
                    <strong>Add passkey</strong> (the whole registration runs
                    server-side, one per account), <strong>Verify</strong> that
                    Telegram still accepts it, and remove them. Accounts with a
                    passkey get <strong>Log in with passkey</strong> in the auth
                    dialog: it signs in and then asks only for the 2FA password.
                    (Experimental)
                  </td>
                </tr>
                <tr>
                  <td>Extra Info column</td>
                  <td>
                    Toggle the <strong>Extra Info</strong> column via the
                    Show/Hide Extra Info button to surface login email,
                    restriction status, and passkey flags. Select accounts and
                    click <strong>Fetch Attributes</strong> to refresh them in
                    bulk.
                  </td>
                </tr>
                <tr>
                  <td>Shift-click range select</td>
                  <td>
                    Hold Shift and click in the accounts table to select the
                    contiguous range between the last-clicked row and the
                    shift-clicked row.
                  </td>
                </tr>
                <tr>
                  <td>Bulk actions</td>
                  <td>
                    Select multiple accounts and operations appear under the
                    <strong>Bulk Actions</strong> menu, sharing a "Gap between
                    accounts (seconds)" control to avoid flood limits:
                    <strong>Bulk Rename</strong> (<code>{index}</code> running
                    number, zero-padding, live preview),
                    <strong>Fetch Attributes</strong>,
                    <strong>Bulk Change Login Email</strong> (a
                    <code>+</code>-tag template on one Gmail inbox, codes read
                    over IMAP with an app password used only for the run and
                    never stored, after a required Test login<span
                      v-if="msApiAvailable"
                      >, or a mailbox of its own leased from a configured
                      msOauth2api address pool, handed back when the run
                      fails</span
                    >; Telegram only replaces a login email and never adds one,
                    so an account with none linked will fail),
                    <strong>Bulk Change Credential</strong>
                    (set/rotate the 2FA password, optionally removing other
                    devices/passkeys), <strong>Bulk Add Passkey</strong>,
                    <strong>Bulk Set Privacy</strong> (pick who can see each
                    setting on the selected accounts -- nobody, my contacts or
                    everybody -- across phone number, last seen, profile photo,
                    bio, birthday, forward attribution, calls and gift display;
                    everything starts at nobody, and setting one to everybody
                    puts it back, so a photo hidden by an earlier run can be
                    restored from the same screen. The two Telegram has no
                    "nobody" for, who can find me by my number and who can add
                    me to groups, go no narrower than my contacts, and
                    Premium-only settings are left out), and
                    <strong>Bulk Rename TG Profile</strong> (set the Telegram
                    first name, last name and intro for many accounts at once --
                    one Tab-separated line per account so columns can be pasted
                    straight from a spreadsheet, click "Generate random names"
                    to fill them, or click "Generate with AI" to have them
                    written to a requirement ("Chinese users, bios in Chinese") --
                    one request covers every selected account, a toggle skips the
                    bios, and what comes back is cleaned to one line, no tabs, and
                    within Telegram's length limits; it runs as a background batch
                    that survives page reloads and retries failed accounts).
                    Setting <code>BULK_ACCOUNT_MANAGEMENT=1</code> also enables
                    <strong>Bulk Add</strong> (one <code>phone----apiUrl</code>
                    per line, auto-creating and authenticating each account by
                    reading the code/2FA from its API page) and
                    <strong>Bulk Clean</strong>. Every bulk action works through
                    its accounts on the server, so once started the dialog -- or
                    the whole page -- can be closed: follow it in the
                    <strong>Background tasks</strong> panel at the bottom right
                    (or by reopening the same dialog) and
                    <strong>Terminate</strong> it there at any time, which stops
                    after the account in flight and marks the rest terminated.
                  </td>
                </tr>
                <tr>
                  <td>Country / flag</td>
                  <td>
                    The country is resolved automatically from the phone
                    number's calling code and shown as a flag and name below
                    the number, with the full name on hover.
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="help-badges-row">
              <span class="badge badge-grey">Unauthenticated</span>
              <span class="badge badge-orange">Pending code / 2FA</span>
              <span class="badge badge-green">Authenticated</span>
              <span class="badge badge-red">Session Expired</span>
              <span class="badge badge-purple"
                ><i
                  class="fa-solid fa-shield-halved"
                  style="margin-right: 3px"
                ></i
                >Proxy name</span
              >
            </div>
            <p class="help-note">
              Only authenticated accounts can run check-in jobs. The Accounts
              page automatically checks all enabled sessions on load and marks
              expired ones as Session Expired.
            </p>
          </template>
        </div>
      </div>

      <!-- Messenger -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">消息（Messenger）</div>
            <p class="help-para">
              内置 Telegram 消息客户端，可直接在 Bemby
              中与联系人、群组和频道实时聊天。
              点击导航栏中的<strong>消息</strong>图标即可打开。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              聊天搜索
            </div>
            <p class="help-para">
              聊天列表顶部的搜索框会先匹配本地已加入聊天的标题与用户名，再对已退出/已归档/无用户名的聊天做全局消息内容匹配，并对公开聊天做全局用户名匹配，结果按相关度排序。加入群组失败时会给出具体原因（私有群组、邀请链接失效、已是成员等），私有群加入失败时自动弹出"输入网址"对话框方便粘贴邀请链接。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              移动端聊天头部
            </div>
            <p class="help-para">
              移动端聊天头部的操作按钮（搜索、清空缓存、小程序模式、打开网址、关闭聊天）合并为单个 ⋯
              菜单，避免挤占聊天名称显示空间。消息区域滚动离底部较远时，右下角会出现"跳转到最新消息"悬浮按钮，并带未读消息数角标。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              表情回应
            </div>
            <p class="help-para">
              将鼠标悬停在任意消息上，点击笑脸图标即可回应。提供 8
              个快捷表情（👍 ❤️ 😂 😮 😢 👎 🔥 🎉）以及完整表情选择器。
              再次点击自己的回应可取消；自己的回应以高亮蓝色显示。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              引用回复
            </div>
            <p class="help-para">
              悬停消息后点击回复图标，输入框上方将显示引用预览条。
              点击聊天中的引用气泡可滚动至原始消息并短暂高亮。 发送后回复关系在
              Telegram 中完整保留。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              内联图片查看
            </div>
            <p class="help-para">
              含图片的消息直接在聊天气泡中展示缩略图，无需跳转外部链接。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              频道帖子评论
            </div>
            <p class="help-para">
              频道消息气泡底部若显示评论数，点击该按钮即可在右侧面板中展开评论线程，并可直接发送回复。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              机器人命令自动补全
            </div>
            <p class="help-para">
              与机器人聊天时，输入框左侧出现
              <code>/</code> 按钮，点击可展开该机器人支持的全部命令及说明。
              在输入框中直接输入
              <code>/</code> 也会触发补全面板，继续输入可按前缀筛选命令。 通过
              <kbd>↑</kbd> <kbd>↓</kbd> 方向键或 <kbd>Tab</kbd> /
              <kbd>Enter</kbd> 选择命令，<kbd>Esc</kbd> 关闭面板。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              自动标记已读
            </div>
            <p class="help-para">
              打开聊天窗口或收到新消息时，自动调用 Telegram API
              将消息标记为已读，并立即清除对话列表中的未读角标。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              静音 / 取消静音
            </div>
            <p class="help-para">
              右键任意对话可选择静音 8 小时、1 周、永久静音或取消静音。
              已静音的对话在列表中显示静音徽标。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              加入文件夹
            </div>
            <p class="help-para">
              右键对话可选择"加入文件夹"，将其添加至任意 Telegram 文件夹。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              编辑联系人
            </div>
            <p class="help-para">
              在个人资料面板中点击铅笔图标，可直接修改联系人的名和姓。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              小程序显示模式
            </div>
            <p class="help-para">
              工具栏中的拼图图标可切换 Telegram 小程序的打开方式：
              高亮时在应用内嵌入式面板打开，否则在浏览器中打开。
            </p>
            <p class="help-para">
              小程序可从三处打开：机器人消息中的小程序按钮、聊天头部的打开按钮，以及左侧机器人菜单里的
              <strong>面板</strong>（贴在输入框旁的机器人菜单小程序，聊天记录里找不到）。地址由 Telegram
              按当前账户签名，并补齐主题、版本、平台等启动参数。多数小程序拒绝被非 Telegram
              站点内嵌，因此内嵌前会先探测；不允许时改由内置代理提供同一页面，页面上方显示提示条。
            </p>
            <p class="help-para">
              个人资料面板中的 <strong>ID</strong> 一行可点击复制（群组为 <code>-100…</code> 形式）。
              没有用户名、也没有邀请链接的私密群组，可用该 ID 填进任务或模板的群组/联系人字段。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              打开网址
            </div>
            <p class="help-para">
              工具栏中的地球图标可打开"输入网址"对话框，支持粘贴任意 URL 或 t.me 链接。
              点击站外链接时会弹出选择卡片，可选"在 Bemby 中打开"或"在浏览器中打开"。
              选择在 Bemby 中打开时，会先探测目标网站是否允许被嵌入 iframe；不允许时自动改为通过内置代理加载，
              页面上方会显示提示条，说明登录及部分交互功能可能无法使用。t.me 链接始终在应用内直接处理，不会弹出选择框。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              发送图片与文件
            </div>
            <p class="help-para">
              点击输入框旁的附件图标可选择图片或任意文件并发送，发送前会在输入框上方显示待发送附件预览。
              图片可选择"以文件方式发送"以保留原始质量。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              拉黑与举报
            </div>
            <p class="help-para">
              在聊天右键菜单或联系人资料面板中可拉黑/取消拉黑用户或机器人。举报支持选择举报原因（垂类，如骚扰信息、色情内容、虚假账号等）并填写可选备注；
              举报用户或机器人时会同时将其拉黑并删除该聊天，对话框中会明确提示此行为。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              删除聊天 / 消息
            </div>
            <p class="help-para">
              右键聊天可选择"删除聊天"，用户/机器人聊天可勾选"同时为对方删除"。单条消息可通过悬停操作删除，也可进入多选模式批量删除，均可勾选"为对方也删除"（频道消息始终对所有人删除）。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              编辑与转发消息
            </div>
            <p class="help-para">
              悬停自己发送的文字消息可点击铅笔图标直接编辑；悬停任意消息可点击转发图标，在弹出的聊天列表中选择目标聊天转发。多选模式下可批量转发或删除。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              输入中提示
            </div>
            <p class="help-para">
              对方正在输入时，聊天列表预览行与聊天窗口头部会显示"正在输入…"；你在输入框中输入内容时，对方也会看到你的输入状态。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              清除缓存 / 清理账号
            </div>
            <p class="help-para">
              消息视图右上角新增两个按钮：<strong>清除缓存</strong>清空该账号在 Bemby
              本地的缓存数据并重新从 Telegram 拉取，用于排查显示异常，不影响 Telegram
              上的实际数据；<strong>清理账号</strong>会退出所选账号的所有群组与频道、删除所有私聊记录、移除所有联系人及自定义文件夹（自动保留"收藏夹"、Telegram 官方通知和
              SpamBot）。此操作<strong>不可撤销</strong>，需在确认框中核对账号信息并勾选风险提示后才能执行，完成后会显示成功/失败的处理数量。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Messenger</div>
            <p class="help-para">
              A built-in Telegram chat client lets you message contacts, groups,
              and channels directly from Bemby. Click the
              <strong>Messages</strong> icon in the sidebar to open it.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Chat search
            </div>
            <p class="help-para">
              The search box above the chat list matches your own chats by
              title or username first, then falls back to a global message
              search for chats you've left, archived, or that have no
              username, plus a global username search for public chats,
              ranked by relevance. Failed group joins show a specific reason
              (private group, expired invite link, already a member), and a
              failed private-group join auto-opens the "Go to URL" dialog so
              you can paste the invite link.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Mobile chat header
            </div>
            <p class="help-para">
              On mobile, the chat header's action buttons (search, clear
              cache, mini app mode, open URL, close chat) collapse into a
              single ⋯ menu so the chat name keeps its space. A floating
              "jump to latest" button appears in the bottom-right once you've
              scrolled away from the bottom, with an unseen-message count
              badge.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Emoji reactions
            </div>
            <p class="help-para">
              Hover any message and click the smiley icon to react. Eight
              quick-pick emojis (👍 ❤️ 😂 😮 😢 👎 🔥 🎉) are available
              alongside a full emoji picker. Tap your own reaction again to
              remove it; your reactions are highlighted blue.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Quoted replies
            </div>
            <p class="help-para">
              Hover a message and click the reply icon to quote it. A preview
              strip appears above the compose box. Click any reply quote in the
              chat to scroll to the original message and briefly highlight it.
              The reply relationship is preserved on Telegram after sending.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Inline photo viewing
            </div>
            <p class="help-para">
              Messages containing photos display the image directly inside the
              chat bubble -- no external link needed.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Channel post comments
            </div>
            <p class="help-para">
              Channel messages with a comment count show a comment button in the
              message footer. Click it to open the thread panel on the right and
              reply to the comment thread directly.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Bot command autocomplete
            </div>
            <p class="help-para">
              When chatting with a bot, a <code>/</code> button appears beside
              the compose box. Click it to expand the full list of commands the
              bot supports, each with its description. Typing
              <code>/</code> directly in the input also opens the panel; keep
              typing to filter by prefix. Navigate with <kbd>↑</kbd>
              <kbd>↓</kbd> or <kbd>Tab</kbd> / <kbd>Enter</kbd> to select;
              <kbd>Esc</kbd> closes the panel.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Auto read-marking
            </div>
            <p class="help-para">
              Opening a chat or receiving a new message automatically calls the
              Telegram API to mark messages as read and clears the unread badge
              on the dialog immediately.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Mute / unmute
            </div>
            <p class="help-para">
              Right-click any dialog to mute it for 8 hours, 1 week, forever,
              or to unmute it. Muted dialogs show a mute badge in the list.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Add to folder
            </div>
            <p class="help-para">
              Right-click a dialog and choose "Add to folder" to add it to any
              of your Telegram folders.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Edit contact
            </div>
            <p class="help-para">
              Click the pencil icon in the profile panel to edit a contact's
              first and last name directly.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Mini app display mode
            </div>
            <p class="help-para">
              The puzzle-piece button in the toolbar toggles how Telegram mini
              apps open: when highlighted, they open in an embedded in-app
              panel; otherwise they open in the browser.
            </p>
            <p class="help-para">
              A Mini App opens from three places: the Mini App button on a bot's message, the
              open button in the chat header, and the bot's menu app in the left-hand menu (the
              one pinned beside the composer, which appears nowhere in the chat history).
              Telegram signs the address for the current account, and the launch parameters a
              real client adds -- theme, version, platform -- are filled in. Most Mini Apps
              refuse to be framed by anything but Telegram, so framing is probed first; where it
              is refused the same page is served through a built-in proxy, with a banner saying
              so.
            </p>
            <p class="help-para">
              The <strong>ID</strong> row in the profile panel copies on click (a group's is the
              <code>-100…</code> form). A private group with no username and no invite link left
              can be named by that ID in a job's or template's group or contact field.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Open URL
            </div>
            <p class="help-para">
              The globe button in the toolbar opens a dialog where you can paste
              any URL or t.me link. Clicking a non-Telegram link shows a chooser
              card with "Open in Bemby" or "Open in browser". Choosing Bemby
              first checks whether the target site allows being embedded in an
              iframe; if it doesn't, the page loads through a built-in proxy
              instead, with a banner noting that sign-ins and some interactive
              features may not work. t.me links are always handled directly
              in-app and never show the chooser.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Send files and images
            </div>
            <p class="help-para">
              Click the attachment icon next to the compose box to pick an image
              or any file and send it; a preview of the pending attachment
              appears above the compose box before sending. Images offer a "send
              as file" option to preserve the original quality.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Block and report
            </div>
            <p class="help-para">
              Block or unblock a user or bot from the chat context menu or the
              contact's profile panel. Reporting lets you pick a reason
              (spam, violence, a fake account, etc.) and add an optional
              comment; reporting a user or bot also blocks them and deletes the
              chat, with the confirmation card calling this out.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Delete chats / messages
            </div>
            <p class="help-para">
              Right-click a chat and choose "Delete chat"; for user/bot chats
              you can also tick "also delete for them". Individual messages can
              be deleted from the hover actions, or in bulk via multi-select,
              both with the same revoke option (channel messages are always
              deleted for everyone).
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Edit and forward messages
            </div>
            <p class="help-para">
              Hover your own text message and click the pencil icon to edit it
              in place. Hover any message and click the forward icon to pick a
              destination chat from the popup list. Multi-select mode lets you
              forward or delete several messages at once.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Typing indicators
            </div>
            <p class="help-para">
              When the other side is typing, "typing…" appears in the dialog
              list preview and the open chat's header. Your own typing status is
              broadcast to them the same way while you compose a message.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Clear cache / Clean account
            </div>
            <p class="help-para">
              Two buttons in the top-right of the Messenger view:
              <strong>Clear cache</strong> wipes Bemby's local cache for the
              account and refetches everything from Telegram — useful when
              something looks stale or wrong, and has no effect on your actual
              Telegram data. <strong>Clean account</strong> leaves every group
              and channel, deletes every private chat history, and removes all
              contacts and custom folders for the selected account (Saved
              Messages, the official Telegram service chat, and SpamBot are
              always kept). This is <strong>irreversible</strong> — the
              confirmation dialog requires checking the account details and
              ticking a risk acknowledgement before it runs, and reports how
              many items succeeded or failed afterwards.
            </p>
          </template>
        </div>
      </div>

      <!-- Jobs -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">任务</div>
            <p class="help-para">支持四种任务类型：</p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              签到（Check-in）
            </div>
            <p class="help-para">
              向 Telegram 机器人发送命令并点击回复键盘上的按钮，完成每日签到。
              <strong>机器人用户名</strong>字段接受带或不带
              <code>@</code> 前缀的机器人账号。
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>启动命令</td>
                  <td>
                    发送给机器人的命令，默认
                    <code>/start</code>。支持模板占位符，留空则使用默认值。
                  </td>
                </tr>
                <tr>
                  <td>签到按钮文字</td>
                  <td>
                    用于在机器人回复的内联键盘中匹配按钮的文字，默认
                    <code>签到</code>。设为 <code>{aiBtn}</code> 可启用 AI
                    自动识别（见下文）。
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>AI 按钮识别（<code>{aiBtn}</code>）</strong> —
              当机器人以图片提问并展示按钮选项时（如图片验证码签到），将签到按钮文字设为
              <code>{aiBtn}</code
              >，系统将调用视觉大模型自动识别正确按钮。需在<strong>设置</strong>页面的"AI
              按钮识别"板块配置 API 地址和密钥，支持
              OpenRouter、阿里云百炼等兼容 OpenAI 格式的服务。
            </p>
            <p class="help-para">
              <strong>命令模板占位符</strong
              >——可在启动命令中嵌入动态内容，每次执行时随机生成：
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td><code>{word}</code> / <code>{word:N}</code></td>
                  <td>N 位随机小写字母（默认 6 位）</td>
                </tr>
                <tr>
                  <td><code>{WORD}</code> / <code>{WORD:N}</code></td>
                  <td>N 位随机大写字母（默认 6 位）</td>
                </tr>
                <tr>
                  <td><code>{num}</code> / <code>{num:N}</code></td>
                  <td>N 位随机数字（默认 6 位）</td>
                </tr>
                <tr>
                  <td>
                    <code>{num:1-30}</code> / <code>{num:01-30}</code>
                  </td>
                  <td>
                    指定范围内的随机整数（含两端）。低位补零的写法（<code>01-30</code>）表示固定位数，输出
                    <code>01</code>–<code>30</code>；不补零则输出
                    <code>1</code>–<code>30</code>。两端顺序可颠倒
                  </td>
                </tr>
                <tr>
                  <td><code>{alpha}</code> / <code>{alpha:N}</code></td>
                  <td>N 位随机大小写字母与数字混合（默认 8 位）</td>
                </tr>
                <tr>
                  <td><code>{uuid}</code></td>
                  <td>随机 UUID v4</td>
                </tr>
                <tr>
                  <td>
                    <code>{randomFirstName}</code> /
                    <code>{randomLastName}</code>
                  </td>
                  <td>随机的常见英文名 / 姓氏（无需填位数）</td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">
              示例：<code>/create {word:4}-{num:6}</code> 发送时会变成
              <code>/create abcd-829341</code>
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              观看（Emby Watch）
            </div>
            <p class="help-para">
              在 Emby 服务器上模拟视频播放会话：随机选择一部影片或剧集，每 30
              秒上报进度， 然后将会话标记为已停止。可用于保持 Emby 账户活跃。
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>服务器地址</td>
                  <td>
                    Emby 服务器完整地址，如
                    <code>https://emby.example.com:443</code
                    >。粘贴含协议和端口的完整 URL 时会自动解析并填充各字段。
                  </td>
                </tr>
                <tr>
                  <td>Emby 用户名 / 密码</td>
                  <td>用于登录 Emby 账户的凭据。</td>
                </tr>
                <tr>
                  <td>播放时长</td>
                  <td>
                    模拟播放的秒数。实际时长会在此基础上随机延长
                    0–10%。留空使用系统默认值。
                  </td>
                </tr>
                <tr>
                  <td>用户代理</td>
                  <td>
                    从预设列表中选择（SenPlayer、Yamby、Hills、Lenna、VidHub），或选"自定义"手动填写。留空使用设置中配置的默认预设。
                  </td>
                </tr>
                <tr>
                  <td>播放后标记已看</td>
                  <td>
                    播放结束后调用 Emby API
                    将该剧集/电影标记为已看。默认开启，可按任务单独配置。
                  </td>
                </tr>
                <tr>
                  <td>账号（可选）</td>
                  <td>
                    用于发送成功/失败通知的 Telegram 账号。留空则不发送通知。
                  </td>
                </tr>
                <tr>
                  <td>上报前校验可播放</td>
                  <td>
                    上报播放前先确认媒体文件可读取（磁盘在线），避免在文件离线时上报虚假观看。
                  </td>
                </tr>
                <tr>
                  <td>真实观看（拉取实际字节）</td>
                  <td>
                    除进度上报外，以真实播放速率从 Emby
                    服务器直连拉取实际媒体字节，使服务器产生与真实客户端一致的串流流量，日志中会记录本次<strong>已串流</strong>的数据量。服务器不提供直连播放时会退回转码地址（含
                    HLS），并在日志中标注<strong>转码</strong>；完全无法拉流时，日志会写明原因而不是只显示
                    0 MB。注意：单次运行可能消耗数百 MB 至数 GB 下行流量。
                  </td>
                </tr>
                <tr>
                  <td>顺序播放（续播）</td>
                  <td>
                    优先从上次离开的位置继续观看（Emby「继续观看」），其次是下一集（Next
                    Up），仍无则随机选择；当前集看完后自动播放同剧集的下一集，直到用尽播放时长。仅在完整看完一集时才标记为已看，未看完的内容会保留在「继续观看」列表中。
                  </td>
                </tr>
                <tr>
                  <td>限定媒体库（可选）</td>
                  <td>
                    填写媒体库名称或其序号（从 1
                    开始），仅从该媒体库中挑选内容（含续播与顺序播放），并校验所选内容确实属于该库。若找不到该媒体库，或库内没有可播放内容，则回退到整个服务器。
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">
              播放从剧集随机 5–10% 处开始，而非从头播放，使行为更接近真实用户。
              Emby 日志中的会话设备将显示为所选 User Agent
              预设对应的客户端（默认为 <strong>Mac / SenPlayer</strong>）。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              自定义（Custom）
            </div>
            <p class="help-para">
              自定义任务通过可配置的多步骤流程操作任意 Telegram
              机器人。每个步骤可执行以下动作：
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>发送命令</td>
                  <td>
                    向机器人发送命令或消息。支持模板占位符（<code
                      >{word:N}</code
                    >
                    等），以及 <code>{aiInput}</code> /
                    <code>{aiInput:N}</code>——自动将上一条消息中的图片发给 AI
                    识别，将识别出的字符填入发送内容。支持独立的<strong>最大重试次数</strong>配置。
                  </td>
                </tr>
                <tr>
                  <td>等待回复</td>
                  <td>
                    等待机器人回复（可设置超时时长），支持独立的<strong>最大重试次数</strong>。可选配<strong>成功包含文字</strong>和<strong>失败包含文字</strong>：收到含成功文字的回复则立即标记成功；收到含失败文字的回复则标记失败（并按配置重试）；两者均留空时，任意回复均视为成功。两者都支持用 <code>|</code> 分隔多个写法，命中任一即可（例：<code>签到成功|签到中</code>），机器人对同一结果有多种措辞时用它。
                  </td>
                </tr>
                <tr>
                  <td>点击按钮</td>
                  <td>
                    点击内联键盘按钮。支持 <code>{aiBtn}</code>（AI
                    自动识别）、<code>{anyBtn}</code>（随机选择）或精确文字匹配，并支持独立的<strong>最大重试次数</strong>。
                  </td>
                </tr>
                <tr>
                  <td>点击多个按钮（AI 选择）</td>
                  <td>
                    由 AI 返回一组按钮文字并按顺序依次点击，每次点击之间可配置<strong>点击间隔（毫秒）</strong>。适用于需按序点选多个选项的流程（如人机验证）。留空<strong>联系人</strong>则在任务机器人对话中操作，填写则在该联系人对话中操作。<strong>成功包含文字</strong>仅在最后一次点击后校验，<strong>失败包含文字</strong>每次点击后校验。
                  </td>
                </tr>
                <tr>
                  <td>输入验证码</td>
                  <td>
                    等待含图片的机器人消息，通过 AI
                    识别图中验证码，再将识别结果自动发送给机器人。可指定验证码字符数量以提高识别准确率——若
                    AI
                    返回的字符数与预期不符，则视为失败并触发重试。支持独立的<strong>最大重试次数</strong>。
                  </td>
                </tr>
                <tr>
                  <td>加入群组 / 订阅频道</td>
                  <td>
                    加入群组或订阅频道，支持公开用户名（<code>@name</code>）或私有邀请链接。订阅频道可先校验当前订阅状态（已订阅则直接成功），发送请求后再次验证；加入群组可选配"入群后点击验证按钮"以完成部分群组的入群验证。
                  </td>
                </tr>
                <tr>
                  <td>向联系人发送 / 点击按钮</td>
                  <td>
                    对流程中指定的机器人、群组或用户发送消息/命令，或点击其最近收到消息上的按钮（可等待新消息）。
                  </td>
                </tr>
                <tr>
                  <td>延时</td>
                  <td>在步骤之间插入固定等待时长。</td>
                </tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>任务最大重试次数</strong
              >——自定义任务专属设置（独立于全局任务重试），失败时从头重新执行整个动作链。
              <strong>动作最大重试次数</strong
              >——每个动作仅重试自身，不影响其他步骤。
            </p>
            <p class="help-note">
              需要在<strong>设置</strong>页面配置 AI API 密钥，方可使用
              <code>{aiBtn}</code>、<code>{aiInput}</code> 和"输入验证码"步骤。
            </p>
            <p class="help-note">
              AI 的提示词与响应始终显示在步骤日志中，无需开启开发者模式。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              时间窗口
            </div>
            <p class="help-para">
              任务每天在<strong>开始时间</strong>与<strong>结束时间</strong>（均为
              HHMM 格式，如 <code>1400</code> 表示
              14:00）之间随机一个时间点运行一次。
              若当前时间已在窗口内，则在剩余窗口时间内调度；若窗口已过，则安排在次日执行。
              多个任务会自动错峰，彼此至少间隔设置中「任务错峰」配置的分钟数（默认
              2 分钟），避免在同一分钟并发执行。
            </p>
            <p class="help-para">
              <strong>每隔多少天执行</strong>控制两次执行之间的间隔天数：填数字（如
              <code>7</code>）为固定间隔，填范围（如
              <code>7-15</code>）则每次排程时在范围内随机取一个天数，使执行节奏不固定。任务与模板均支持。
            </p>
            <p class="help-note">
              在设置中关闭<em>每天仅运行一次</em>，可让调度器对今天已运行过的任务重新触发，便于测试。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              启用 / 禁用
            </div>
            <p class="help-para">
              点击任务列表中<strong>启用</strong>列的状态标签，可直接切换任务的启用状态，无需打开编辑表单。
              禁用任务时会弹出确认框；重新启用时无需确认。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              复制任务
            </div>
            <p class="help-para">
              在任务列表中点击任意任务行的<strong>复制</strong>按钮，可将该任务的全部配置预填至新建任务表单，修改名称后保存即可。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              任务筛选与搜索
            </div>
            <p class="help-para">
              当系统存在多个账号或多个机器人/网址时，任务列表顶部会显示对应的筛选下拉框，可按账号或机器人/网址过滤任务。列表顶部同时提供名称搜索框，可按任务名称快速筛选。任务、账户、日志、模板列表均为服务端分页，分页控件位于表格上方；筛选下拉选项覆盖全部数据而非仅当前页。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              自动注册（Auto-register）
            </div>
            <p class="help-para">
              监听群组里发布的注册码并抢注。<strong>注册码群组</strong>支持公开用户名、私有邀请链接，或群组 ID（<code>-100…</code>，在 Messenger 的资料面板复制；填 ID 表示本账户已在群内）。
            </p>
            <p class="help-para">
              <strong>注册码前缀</strong>与<strong>注册码正则</strong>二者填其一即可：前缀支持 <code>*</code> 通配（例 <code>ABC-*-XYZ_</code>）；正则用于没有固定前缀的群，有捕获组时取第 1 组，也可写 <code>/pattern/i</code> 形式加标志。群里announce为“已被使用”的码会自动作废。
            </p>
            <p class="help-para">
              发送前可对注册码做<strong>即时处理</strong>：勾选“移除中文字符”，或在“移除指定字符”里填 <code>~*</code> 之类逐字符删除——这两项不需要 AI、没有额外等待。若群里的说明更复杂（删除某个符号、替换字符、注册码被拆开写），可开启 <strong>AI 修正注册码</strong>：发送前把注册码连同该消息、其前后消息与机器人提示一并交给 AI，按群内说明修正；一次请求覆盖整批，AI 不可用时按原样发送。
            </p>
            <p class="help-para">
              <strong>提交方式</strong>可选“点击注册按钮后发送注册码”或“随启动命令一并发送”。两处可选的等待文字用于避免浪费注册码：<strong>发送注册码前等待文字</strong>（如 <code>对我发送注册</code>）在点击注册按钮后等机器人就绪；<strong>发送用户名前等待文字</strong>在注册码被接受后等机器人索要用户名。超时仍会发送，并在日志中写明。
            </p>
            <p class="help-para">
              有些机器人会<strong>先校验注册码</strong>，通过后才在回复里给出真正开始注册的按钮或链接；注册码无效时则直接回复已被使用，此时应立即尝试下一个。判定文字由<strong>成功包含文字</strong>与<strong>失败包含文字</strong>决定（多个关键字用 <code>|</code> 分隔）。若通过后还需点击，请开启<strong>注册码通过后再点击一次按钮/链接</strong>并填写要匹配的文字（留空取第一个可点击项）。支持回调按钮与 <code>?start=</code> 链接（含正文中的文字链接）；纯网页链接需要浏览器，请改用自定义任务的“打开网址”动作。该步骤可标记为<strong>必需</strong>（找不到按钮即视为此码失效，换下一个）或保持可选（仅记录并继续发送用户名）——机器人只是有时才要求这一步时用后者。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              小程序（Mini App）与网页子步骤
            </div>
            <p class="help-para">
              自定义任务可打开小程序并在其中操作：<strong>打开小程序</strong>（在最近消息里找按钮）、<strong>打开小程序（网址）</strong>（<code>t.me/&lt;机器人&gt;/&lt;应用&gt;</code> 链接由链接自身确定机器人，普通 https 地址由“所属机器人”签名）、<strong>打开机器人菜单小程序</strong>（贴在输入框旁的那个，聊天记录里找不到）。
            </p>
            <p class="help-para">
              打开后可编排<strong>子步骤</strong>：点击、填写、等待元素、滚动（元素或页面）、断言文字；标签支持多语言候选（同一按钮在不同语言下的写法），也支持 CSS 选择器。小程序在流程中途弹出 Cloudflare Turnstile 人机验证时，用 <code>{turnstile}</code> 步骤勾选复选框，它通过浏览器协议定位组件，无需 AI 判断坐标；IP 良好时验证会自动通过、页面上不出现复选框，此时该步骤同样算成功。地址由 Telegram 按本任务的账户签名，并在已安装的指纹修补浏览器中打开，因此能通过 Cloudflare 验证；<strong>浏览器代理</strong>决定出口 IP（与 Telegram 连接分开），可开启“依次尝试其他代理”。凡是可以选择代理的位置，都可以选择<strong>随机代理</strong>：每次运行从勾选的随机池中抽取一个（不勾选则从整个代理列表抽取），被拒绝时的轮换也只在该池内进行。随机池可按<strong>供应商</strong>整体勾选，代表其当前的全部代理，同步后新增或删除的代理会自动跟随。健康检查失败的代理会被<strong>停用</strong>，抽取、供应商与轮换都会跳过；导入或刷新代理列表后会立即测试一次，也可在“设置 → 代理”中设置自动测试间隔，并可额外要求能访问 challenges.cloudflare.com 或指定网址。测试失败而停用的代理仍会参与每次测试，通过后自动恢复；此外可在代理列表中<strong>手动关闭</strong>某个代理，手动关闭不会被自动测试覆盖，只能手动启用。还可开启<strong>使用前先检查代理</strong>：任务运行前测试即将使用的代理，随机池按抽取顺序依次检查并使用第一个可用的；若只剩一个代理且检查失败，任务直接失败，不会改用本机 IP 出网。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              计划列表
            </div>
            <p class="help-para">
              任务页面顶部的<strong>下次计划运行</strong>面板按日期分组列出即将运行的任务。在<strong>设置</strong>中可把它独立为左侧菜单的<strong>计划</strong>页（完整列表、不再限高）。每一项按任务类型显示图标与颜色（签到 / 观看 / 自定义 / 注册）。
            </p>
            <p class="help-para">
              点击某一项右侧的 <strong>✕</strong> 可<strong>取消这次运行</strong>：任务本身保持启用，按其运行间隔顺延到下一个可运行日（每 3 天运行的任务顺延 3 天）。这只影响这一次，不等于停用任务。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              列排序
            </div>
            <p class="help-para">
              点击任意列标题可对任务列表按该列排序，再次点击切换升序/降序。点击行本身可高亮选中该行。
              筛选条件与排序方式在刷新后自动恢复。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              批量运行
            </div>
            <p class="help-para">
              勾选多个任务后，批量操作栏出现<strong>运行 (N)</strong> 按钮。
              点击后可设置任务间延迟时间（默认 70 秒），确认后任务按顺序依次执行。
              队列在服务器上运行，可以关闭页面；进度在右下角的<strong>后台任务</strong>面板中查看，也可随时终止（正在运行的那个任务会被取消，其余不再执行）。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              批量修改时间窗口
            </div>
            <p class="help-para">
              勾选多个任务后点击<strong>修改时间窗口 (N)</strong>，可一键将所选任务的时间窗口批量设置为相同的开始/结束时间。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              归档任务
            </div>
            <p class="help-para">
              删除任务时改为<strong>归档</strong>，任务从列表中移除但其历史日志得以保留。支持单个及批量归档。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              移动端操作菜单
            </div>
            <p class="help-para">
              在移动端，每行的操作按钮（运行、编辑、复制、删除）合并为单一的
              <strong>⋯</strong> 按钮。
              点击后从屏幕底部弹出操作菜单，选择所需操作后菜单自动关闭；点击空白处可取消。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Jobs</div>
            <p class="help-para">Four job types are supported:</p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Check-in (签到)
            </div>
            <p class="help-para">
              Sends a command to a Telegram bot and clicks the reply keyboard
              button to perform a daily check-in. The
              <strong>Bot Username</strong> field accepts the bot handle with or
              without the leading <code>@</code>.
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>Start Command</td>
                  <td>
                    Command sent to the bot, default <code>/start</code>.
                    Supports template placeholders. Leave blank to use the
                    default.
                  </td>
                </tr>
                <tr>
                  <td>Check-in Button</td>
                  <td>
                    Text used to match the inline keyboard button, default
                    <code>签到</code>. Set to <code>{aiBtn}</code> to enable AI
                    auto-detection (see below).
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>AI button detection (<code>{aiBtn}</code>)</strong> — when
              a bot presents an image alongside button choices (e.g. a
              CAPTCHA-style check-in), set the check-in button to
              <code>{aiBtn}</code> and a vision model will automatically
              identify the correct button. Configure the API endpoint and key in
              the <strong>Settings</strong> page under "AI Button Detection".
              Any OpenAI-compatible provider works (e.g. OpenRouter, Aliyun
              DashScope).
            </p>
            <p class="help-para">
              <strong>Command template placeholders</strong> — embed dynamic
              content that is randomly generated each run:
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td><code>{word}</code> / <code>{word:N}</code></td>
                  <td>N random lowercase letters (default 6)</td>
                </tr>
                <tr>
                  <td><code>{WORD}</code> / <code>{WORD:N}</code></td>
                  <td>N random uppercase letters (default 6)</td>
                </tr>
                <tr>
                  <td><code>{num}</code> / <code>{num:N}</code></td>
                  <td>N random digits (default 6)</td>
                </tr>
                <tr>
                  <td>
                    <code>{num:1-30}</code> / <code>{num:01-30}</code>
                  </td>
                  <td>
                    A whole number in that range, both ends included. Writing the
                    low bound with a leading zero (<code>01-30</code>) fixes the
                    width, giving <code>01</code>–<code>30</code>; without one it
                    gives <code>1</code>–<code>30</code>. The bounds may be given
                    either way round
                  </td>
                </tr>
                <tr>
                  <td><code>{alpha}</code> / <code>{alpha:N}</code></td>
                  <td>
                    N random mixed-case alphanumeric characters (default 8)
                  </td>
                </tr>
                <tr>
                  <td><code>{uuid}</code></td>
                  <td>Random UUID v4</td>
                </tr>
                <tr>
                  <td>
                    <code>{randomFirstName}</code> /
                    <code>{randomLastName}</code>
                  </td>
                  <td>An ordinary given name / surname (no length to give)</td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">
              Example: <code>/create {word:4}-{num:6}</code> sends as
              <code>/create abcd-829341</code>
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Emby Watch (观看)
            </div>
            <p class="help-para">
              Simulates a video playback session on an Emby server. Picks a
              random movie or episode, reports progress every 30 seconds, then
              marks the session as stopped. Useful for keeping Emby accounts
              active.
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>Server URL</td>
                  <td>
                    Full address of the Emby server, e.g.
                    <code>https://emby.example.com:443</code>. Paste a URL with
                    protocol and port and the fields are auto-filled.
                  </td>
                </tr>
                <tr>
                  <td>Emby Username / Password</td>
                  <td>Credentials for the Emby account to log in as.</td>
                </tr>
                <tr>
                  <td>Play Duration</td>
                  <td>
                    Seconds to simulate playback. Actual duration is this value
                    plus a random 0–10% extra. Blank uses the system default.
                  </td>
                </tr>
                <tr>
                  <td>User Agent</td>
                  <td>
                    Select from the preset list (SenPlayer, Yamby, Hills, Lenna,
                    VidHub) or choose "Custom..." to enter a value manually.
                    Blank uses the default preset configured in Settings.
                  </td>
                </tr>
                <tr>
                  <td>Mark as watched</td>
                  <td>
                    Calls the Emby PlayedItems API after playback ends to mark
                    the item as watched. On by default; configurable per job.
                  </td>
                </tr>
                <tr>
                  <td>Account (optional)</td>
                  <td>
                    Telegram account used to send success/failure notifications.
                    Leave blank to disable notifications for this job.
                  </td>
                </tr>
                <tr>
                  <td>Verify playable before reporting</td>
                  <td>
                    Confirms the media file is readable (disk online) before
                    reporting playback, avoiding a fake watch when the file is
                    offline.
                  </td>
                </tr>
                <tr>
                  <td>Real Watch (stream actual bytes)</td>
                  <td>
                    On top of the progress reports, the actual media bytes are
                    pulled from the Emby server at real playback pace (direct
                    play), so the server records genuine streaming traffic like a
                    real client; the log stores how much was
                    <strong>Streamed</strong>. When the server offers no direct
                    play it falls back to the transcode stream (including HLS)
                    and the log marks it <strong>transcoded</strong>; when no
                    bytes can be pulled at all, the log states why instead of
                    just showing 0 MB. Note: a single run can use hundreds of MB
                    to several GB of download bandwidth.
                  </td>
                </tr>
                <tr>
                  <td>Sequence Play (resume &amp; continue)</td>
                  <td>
                    Resumes from where the account left off (Emby Continue
                    Watching), falling back to the next unwatched episode (Next
                    Up) and then a random item; when an episode finishes it plays
                    the next one in the show until the play duration is used up.
                    An episode is only marked watched when it actually finishes,
                    so a partly-watched item stays in Continue Watching.
                  </td>
                </tr>
                <tr>
                  <td>Limit to library (optional)</td>
                  <td>
                    Enter a library name or its index (starting from 1) to pick
                    content only from that library, including resume and Sequence
                    Play, verifying that the chosen item really belongs to it. If
                    the library can't be matched, or has nothing to play, it
                    falls back to the whole server.
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">
              Playback starts at a random position 5–10% into the episode rather
              than from the beginning, making the session more realistic. The
              device appears in Emby as the client matching the selected User
              Agent preset (default: <strong>Mac / SenPlayer</strong>).
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Custom (自定义)
            </div>
            <p class="help-para">
              Custom jobs run configurable multi-step flows against any Telegram
              bot. Available step types:
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>Send command</td>
                  <td>
                    Sends a command or message to the bot. Supports template
                    placeholders (<code>{word:N}</code>, etc.) and
                    <code>{aiInput}</code> / <code>{aiInput:N}</code> -- the
                    image from the previous bot message is sent to AI, the
                    recognised characters are substituted into the message
                    before sending. Has its own
                    <strong>Max retries</strong> setting.
                  </td>
                </tr>
                <tr>
                  <td>Wait for reply</td>
                  <td>
                    Waits for the bot to reply, with a configurable timeout and
                    its own <strong>Max retries</strong> setting. Optional
                    <strong>Success contains</strong> and
                    <strong>Fail contains</strong> fields let you classify the
                    reply by text: if the reply contains the success text the
                    action succeeds immediately; if it contains the fail text
                    the action fails (and retries if configured). Leave both
                    empty and any reply counts as success. Both accept
                    alternative wordings separated by <code>|</code>, any one of
                    which counts (e.g. <code>checked in|checking in</code>) --
                    for a bot with more than one wording for the same outcome.
                  </td>
                </tr>
                <tr>
                  <td>Click button</td>
                  <td>
                    Clicks an inline keyboard button. Supports
                    <code>{aiBtn}</code> (AI picks the button),
                    <code>{anyBtn}</code> (random pick), or exact text. Has its
                    own <strong>Max retries</strong> setting.
                  </td>
                </tr>
                <tr>
                  <td>Click multiple buttons (AI picks)</td>
                  <td>
                    The AI returns a list of button texts and clicks each in
                    order, with a configurable <strong>gap between clicks
                    (ms)</strong>. Useful for flows that require selecting
                    several options in sequence (e.g. a captcha). Leave
                    <strong>Contact</strong> blank to operate in the job's bot
                    chat, or set one to operate in that chat.
                    <strong>Buttons message contains</strong> pins the action to
                    one wording (e.g. <code>请在 180 秒内</code>), so a different
                    menu in the same chat is never the one clicked; whitespace is
                    ignored and the wait is bounded by <strong>Max wait</strong>.
                    <strong>Success contains</strong> is checked only after the
                    final click; <strong>Fail contains</strong> is checked after
                    every click.
                  </td>
                </tr>
                <tr>
                  <td>Enter captcha</td>
                  <td>
                    Waits for a bot message containing an image, sends it to AI
                    to recognise the captcha characters, then automatically
                    sends the answer back. An optional character-count hint
                    improves accuracy -- if the AI response does not match the
                    expected length the action fails and retries. Has its own
                    <strong>Max retries</strong> setting.
                  </td>
                </tr>
                <tr>
                  <td>Join group / Subscribe channel</td>
                  <td>
                    Join a group or subscribe to a channel via a public username
                    (<code>@name</code>) or private invite link. Channel
                    subscribe can pre-check the current subscription status
                    (succeeds immediately if already subscribed) and re-verify
                    after sending; join group optionally clicks a verification
                    button after joining to clear some groups' entry checks.
                    When many accounts join at once the group posts one prompt
                    per joiner, so <strong>Only click a prompt that @-mentions
                    this account</strong> restricts the click to the prompt
                    naming this account (@username, a text mention when no
                    username is set, or its numeric ID) and waits past the
                    others.
                  </td>
                </tr>
                <tr>
                  <td>Send / click button for contact</td>
                  <td>
                    Send a message/command to, or click a button on the latest
                    received message from, a specific bot, group, or user named
                    in the flow (can wait for a new message).
                  </td>
                </tr>
                <tr>
                  <td>Delay</td>
                  <td>Pauses for a fixed duration between steps.</td>
                </tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>Job max retries</strong> -- a per-custom-job setting
              (separate from the global job retry) that reruns the entire action
              chain from the beginning on failure.
              <strong>Action max retries</strong> -- each action retries only
              itself on failure; the rest of the chain is unaffected.
            </p>
            <p class="help-note">
              An AI API key must be configured in
              <strong>Settings</strong> before using <code>{aiBtn}</code>,
              <code>{aiInput}</code>, or Enter captcha steps.
            </p>
            <p class="help-note">
              AI prompt and response are always shown in the step log,
              regardless of whether developer logs are enabled.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Schedule Window
            </div>
            <p class="help-para">
              Jobs run once per day at a random time between
              <strong>Window Start</strong> and
              <strong>Window End</strong> (both in HHMM format, e.g.
              <code>1400</code> = 2:00 pm). If the current time is already
              inside the window, the job is scheduled within the remaining
              window time today. If the window has passed, it is scheduled for
              tomorrow. Jobs are automatically staggered at least the number of
              minutes configured under <em>Job Staggering</em> in Settings
              (default 2) so they never run in the same minute.
            </p>
            <p class="help-para">
              <strong>Run every (days)</strong> sets the gap between runs: a
              number (e.g. <code>7</code>) is a fixed interval, while a range
              (e.g. <code>7-15</code>) picks a random day count within the range
              each time the job schedules, so the cadence is not fixed. Both jobs
              and templates support it.
            </p>
            <p class="help-note">
              Disable <em>Enforce one run per day</em> in Settings to allow the
              scheduler to re-trigger jobs that have already run today -- useful
              for testing.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Enable / Disable
            </div>
            <p class="help-para">
              Click the status badge in the <strong>Enabled</strong> column to
              toggle a job on or off without opening the edit form. Disabling a
              job requires confirmation; re-enabling is immediate.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Duplicate Job
            </div>
            <p class="help-para">
              Click the <strong>Duplicate</strong> button on any job row to copy
              all of its settings into the new job form. The name is pre-filled
              as "<em>original name</em> (copy)" -- update it and save.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Job Filters and Search
            </div>
            <p class="help-para">
              When more than one account or bot/URL exists, filter dropdowns
              appear at the top of the jobs list, letting you show only jobs for
              a specific account or bot target. A name search box at the top of
              the list narrows jobs by name. Jobs, Accounts, Logs, and
              Templates all page through results server-side, with the
              pagination bar above the table; filter dropdown options cover
              the whole dataset, not just the loaded page.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Auto-register
            </div>
            <p class="help-para">
              Watches a group for registration codes and races to claim one. The <strong>code group</strong> takes a public username, a private invite link, or a group ID (<code>-100…</code>, copied from the Info panel in Messenger; an ID means this account is already in the group).
            </p>
            <p class="help-para">
              A <strong>code prefix</strong> or a <strong>code regex</strong> -- one of the two is enough. The prefix supports <code>*</code> as a wildcard (<code>ABC-*-XYZ_</code>); the regex covers groups with no stable prefix, taking capture group 1 where the pattern has one, and <code>/pattern/i</code> works for flags. Codes the group announces as used are burned automatically.
            </p>
            <p class="help-para">
              Codes can be cleaned <strong>instantly</strong> before they are sent: tick “Strip Chinese characters”, or list characters like <code>~*</code> under “Strip these characters” to remove each of them -- neither needs the AI and neither adds any wait. Where the group's instruction is more involved (delete a symbol, swap a character, a code split across lines), turn on <strong>Fix the code with AI</strong>: the model is shown the code along with its own message, the messages around it and the bot's prompt, and adjusts it as instructed. One request covers the batch, and the captured code is sent as it stands if the AI is unavailable.
            </p>
            <p class="help-para">
              <strong>How the code reaches the bot</strong> is either “click the register button first” or “alongside the start command”. Two optional waits keep a code from being wasted: <strong>wait for this before sending the code</strong> (e.g. <code>对我发送注册</code>) holds after the register button until the bot is listening, and <strong>wait for this before sending the username</strong> holds after a code is accepted until the bot asks for the name. On timeout it is sent anyway, and the log says so.
            </p>
            <p class="help-para">
              Some bots <strong>vet the code first</strong> and only then offer the button or link that actually opens registration; a code that is already used gets a rejection instead, and the next one should be tried at once. Which is which comes from <strong>Success contains</strong> and <strong>Fail contains</strong> (several keywords separated by <code>|</code>). Where a click is needed after that, turn on <strong>Click a button/link after the code is verified</strong> and give the text to match (blank takes the first clickable one). Callback buttons and <code>?start=</code> links are supported, including a link in the message text; a plain web link needs a browser, so use a custom job's “Open URL” action for that. Mark the step <strong>required</strong> (no button means this code is spent, so the next one is tried) or leave it optional (logged, and the username is sent anyway) -- the latter is for a bot that only sometimes asks for the extra click.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Mini Apps and page sub-steps
            </div>
            <p class="help-para">
              A custom job can open a Mini App and work inside it: <strong>Open Mini App</strong> (finds the button in recent messages), <strong>Open Mini App (URL)</strong> (a <code>t.me/&lt;bot&gt;/&lt;app&gt;</code> link names its own bot; a plain https address is signed through the owning bot), and <strong>Open the bot's menu Mini App</strong> (the one pinned beside the composer, which appears nowhere in the chat history).
            </p>
            <p class="help-para">
              Once open, <strong>sub-steps</strong> drive it: click, fill, wait for an element, scroll (an element or the page), assert text. Labels accept multi-language alternatives for a control worded differently per locale, and CSS selectors work too. A Cloudflare Turnstile checkbox the app raises partway through its flow is ticked by the <code>{turnstile}</code> step, which finds the widget through the browser's own protocol instead of guessing at coordinates; a page that shows no checkbox passes the step, because Turnstile clears itself for an address it likes. The address is signed by Telegram for this job's account and opened in the installed fingerprint-patched browser, which is what gets past Cloudflare; the <strong>browser proxy</strong> sets the exit IP (separate from the Telegram connection) and can work through the rest of the list when an exit is refused. Anywhere a proxy is picked, <strong>Random</strong> draws one per run instead, from a pool you tick or from the whole list when you tick none; a refusal then falls through that pool rather than the whole list. A pool can be ticked by <strong>supplier</strong> instead of exit by exit, which stands for whatever that provider currently lists, so a sync that adds or drops proxies is followed. An exit that fails its health check is <strong>disabled</strong> and every draw, supplier and rotation skips it. An import or refresh tests its list on arrival, Settings &rarr; Proxies sets how often the whole list is re-tested on its own, and a test can be asked to require reaching challenges.cloudflare.com or a URL of your own. Exits a test disabled are tested along with the rest, which is how one comes back. An exit can also be <strong>turned off by hand</strong> in the proxy list: no test sets or clears that, and it rejoins the draws only when you turn it back on. <strong>Check the exit before a run uses it</strong> adds a test on the run's own path: a draw takes the first candidate that answers, and a single exit that refuses fails the run rather than letting it out through the host's own address.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Schedule list
            </div>
            <p class="help-para">
              The <strong>Upcoming runs</strong> panel at the top of the Jobs page groups the next runs by day. Settings can move it to its own <strong>Schedule</strong> entry in the left menu, where the full list is shown without the height cap. Each chip carries an icon and colour for its job type (check-in / watch / custom / autoreg).
            </p>
            <p class="help-para">
              The <strong>✕</strong> on a chip <strong>calls off that run</strong>: the job stays enabled and moves to its next eligible day, respecting its run-every-days interval (a job that runs every third day moves three days). It affects that occurrence only -- it is not the same as disabling the job.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Sorting
            </div>
            <p class="help-para">
              Click any column header to sort the job list by that column; click
              again to reverse the direction. Clicking a row highlights it.
              Filter selections and sort order are both remembered across page
              refreshes.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Bulk Run
            </div>
            <p class="help-para">
              Tick checkboxes on multiple job rows and click
              <strong>Run (N)</strong> in the bulk action bar. Set a delay
              between jobs (default 70 s) and confirm -- jobs run sequentially,
              each waiting for the previous one to finish before starting.
              The queue runs on the server, so the page can be closed: watch it
              in the <strong>Background tasks</strong> panel at the bottom right,
              and terminate it there at any time (the run in flight is cancelled
              and the rest are skipped).
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Bulk Change Window
            </div>
            <p class="help-para">
              Select multiple jobs and click
              <strong>Change Window (N)</strong> to set them all to the same
              start/end time window in one action.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Retire Jobs
            </div>
            <p class="help-para">
              Removing a job now <strong>retires</strong> it: the job leaves the
              list but its history logs are kept. Single and bulk retire are both
              supported.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Mobile Action Menu
            </div>
            <p class="help-para">
              On mobile, the per-row action buttons (Run, Edit, Duplicate,
              Delete) are merged into a single <strong>⋯</strong> button.
              Tapping it opens a bottom action sheet; choose an action and the
              sheet closes automatically, or tap outside to dismiss.
            </p>
          </template>
        </div>
      </div>

      <!-- Templates -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">模板</div>
            <p class="help-para">
              模板存储可复用的任务配置。将任务关联至模板后，模板的变更会自动同步至所有关联任务。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              批量永久静音机器人
            </div>
            <p class="help-para">
              勾选多个模板行，点击<strong>永久静音机器人</strong>按钮，将为所有关联 Telegram 账户一次性静音对应机器人的通知。
              操作内置速率限制保护，每次账户调用间隔 4 秒。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              分享模板
            </div>
            <p class="help-para">
              点击任意行的分享图标，将该模板以 JSON 格式复制至剪贴板。
              如需同时分享多个模板，勾选对应行左侧的复选框，然后点击页头的<strong
                >分享所选 (N)</strong
              >
              按钮，所有选中模板将以 JSON 数组形式一并复制。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              导入模板
            </div>
            <p class="help-para">
              点击页头的<strong>导入模板</strong>按钮，在弹出的文本框中粘贴 JSON
              内容并确认：
            </p>
            <ul class="help-steps">
              <li>
                粘贴单个 JSON 对象 <code>{"{"}"name": "..."{"}"}</code> —
                导入一个模板
              </li>
              <li>
                粘贴 JSON 数组 <code>[{"{"}"name": "..."{"}"}, ...]</code> —
                批量导入多个模板
              </li>
            </ul>
          </template>
          <template v-else>
            <div class="card-section-title">Templates</div>
            <p class="help-para">
              Templates store reusable job configurations. Jobs linked to a
              template inherit its settings; changes to the template propagate
              to all linked jobs automatically.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Bulk mute bot forever
            </div>
            <p class="help-para">
              Tick checkboxes on multiple template rows and click
              <strong>Mute Bot Forever</strong> to mute the associated bot
              across every linked Telegram account in one action. Built-in
              4-second rate-limit protection prevents flooding the Telegram API.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Sharing templates
            </div>
            <p class="help-para">
              Click the share icon on any template row to copy it as JSON to the
              clipboard. To share multiple templates at once, tick the
              checkboxes on the rows you want and click
              <strong>Share Selected (N)</strong> in the page header — all
              selected templates are copied as a JSON array.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Importing templates
            </div>
            <p class="help-para">
              Click <strong>Import Template</strong> in the header, paste JSON
              into the textarea, and confirm:
            </p>
            <ul class="help-steps">
              <li>
                Paste a single JSON object
                <code>{"{"}"name": "..."{"}"}</code> to import one template.
              </li>
              <li>
                Paste a JSON array
                <code>[{"{"}"name": "..."{"}"}, ...]</code> to import multiple
                templates at once.
              </li>
            </ul>
          </template>
        </div>
      </div>

      <!-- Data store -->
      <div v-if="dataStoreEnabled" class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">数据</div>
            <p class="help-para">
              任务可长期保存并读取的数据，在「设置」中开启。文件夹下存放记录，每条记录有一个键和一个取值——
              可以是 JSON 对象，也可以是字符串、数字这样的单个值。与任务变量（「设置变量」步骤）不同，
              这里的数据在本次运行结束后依然存在，因此适合保存刚注册好的账号、站点发放的邀请码等。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              读取
            </div>
            <p class="help-para">
              在任务的任意文本框中写 <code>{{ "{data.文件夹.键}" }}</code> 读取整条记录，
              写 <code>{{ "{data.文件夹.键.字段}" }}</code> 读取记录中的某个字段（嵌套用
              <code>login.password</code>，数组用 <code>items.0</code>）。
              例如 <code>{{ "{data.example.email.password}" }}</code>。
              引用不存在时原样保留，以便从日志中看出是哪一处引用出了问题。
              若需要用在 CSS 选择器中，或希望「没有存过就直接失败」，请改用网页步骤「读取数据」。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              按序号取记录（把文件夹当队列用）
            </div>
            <p class="help-para">
              记录键的位置可以写 <code>#0</code> 表示该文件夹的第一条记录、<code>#1</code> 表示第二条
              （按添加顺序，与面板中按键名排序的显示顺序不同）。引用和所有数据步骤都支持，
              因此一批待用的账号无需写出键名：<code>{{ "{data.文件夹.#0.password}" }}</code>。
              字段路径写 <code>#key</code> 则取记录自身的键——当「键」本身就是要用的值（用户名、邮箱）时正需要它：
              <code>{{ "{data.文件夹.#0.#key}" }}</code>。
              若确实存在键名为 <code>#0</code> 的记录，则优先取该记录；纯数字仍按键名处理，
              <code>0</code> 指键名为 <code>0</code> 的记录，而不是序号。
            </p>
            <p class="help-para">
              网页步骤<strong>按序号取记录</strong>做的是同一件事，但会把键与取值存入变量：
              用在选择器中，或需要用<strong>删除数据</strong>精确删掉本次用过的那一条时，用它更合适。
              删掉之后队列前进一位：原来的第 1 条就成了下次运行的第 0 条。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              写入与删除
            </div>
            <p class="help-para">
              在网页步骤中添加<strong>保存到数据</strong>或<strong>删除数据</strong>：
              填写文件夹、记录键，以及可选的字段路径（留空表示整条记录）。
              保存时文件夹与记录不存在会自动创建；内容若是合法 JSON 则按 JSON 保存。
              填了字段路径则只覆盖该字段，记录中的其他字段保留。
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              导出
            </div>
            <p class="help-para">
              「导出此文件夹」下载 JSON；<strong>导出为文本</strong>则按自定的每行格式下载
              <code>文件夹名.txt</code>，例如
              <code>{{ "{key}----{password}" }}</code> 得到
              <code>me@example.com----hunter2</code> 这样的一行。
              可用占位为 <code>{{ "{key}" }}</code>、<code>{{ "{value}" }}</code>、
              <code>{{ "{updatedAt}" }}</code>，其他名称表示取值中的字段（<code>{{ "{a.b}" }}</code>
              取字段中的字段）；<code>\t</code> 与 <code>\n</code> 可用于生成 Tab 分隔的文件。
              下载前有预览，字段名写错会直接看到空列；格式记在该文件夹上，下次导出自动带出。
            </p>
            <p class="help-note">
              文件夹名与记录键只能包含字母、数字、下划线和连字符，以便写成引用形式。
              数据以原文保存、未加密，且会随「设置」中的完整备份一并导出；只应由后台使用的密码请改用「设置」中的密钥（Secrets）。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Data</div>
            <p class="help-para">
              Values a job can keep and read back long after the run that saved
              them, switched on in Settings. A folder holds records; a record has
              a key and a value — a JSON object, or a single piece of data like a
              string or a number. Unlike a job variable (the
              <strong>Set a variable</strong> step), what is here outlives the
              run, which is what the account a signup just made, or an invite
              code a site handed out, needs.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Reading
            </div>
            <p class="help-para">
              Write <code>{{ "{data.folder.key}" }}</code> in any text field of a
              job for the whole record, or
              <code>{{ "{data.folder.key.field}" }}</code> for one field of it
              (<code>login.password</code> for a nested one,
              <code>items.0</code> into a list) — for example
              <code>{{ "{data.example.email.password}" }}</code>. A reference
              with nothing behind it is left as it stands, so the log shows which
              one was wrong. When the value has to reach a CSS selector, or
              nothing stored should stop the run, use the
              <strong>Read from Data</strong> page step instead.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Taking records in turn (a folder as a queue)
            </div>
            <p class="help-para">
              Write <code>#0</code> where the record key goes for the folder's
              first record, <code>#1</code> for the next — in the order records
              were added, which is not the panel's listing by key. It works in a
              reference and in every data step, so a batch of accounts waiting to
              be used needs no key spelled out:
              <code>{{ "{data.folder.#0.password}" }}</code>. The path
              <code>#key</code> reads the record's own key, which is the useful
              part when the key <em>is</em> the value — a username, an address:
              <code>{{ "{data.folder.#0.#key}" }}</code>. A record whose key is
              literally <code>#0</code> still wins, and a plain number is a key
              like any other: <code>0</code> names the record called
              <code>0</code>, never a position.
            </p>
            <p class="help-para">
              The <strong>Take a record by position</strong> page step does the
              same thing with the key and the value held in variables, which is
              what a selector needs, or a
              <strong>Delete from Data</strong> that should remove exactly the
              record this run used. Deleting it moves the queue on: what had been
              number 1 becomes the next run's number 0.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Writing and deleting
            </div>
            <p class="help-para">
              Add a <strong>Save to Data</strong> or
              <strong>Delete from Data</strong> page step: a folder, a record
              key, and an optional field path (blank means the whole record).
              Saving makes the folder and the record if they are not there yet,
              and text that reads as JSON is stored as JSON. With a field path
              only that field is written, and the rest of the record is left
              alone.
            </p>
            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Exporting
            </div>
            <p class="help-para">
              "Export this folder" downloads JSON.
              <strong>Export as text</strong> downloads
              <code>foldername.txt</code> instead, a line per record to a format
              you write: <code>{{ "{key}----{password}" }}</code> gives
              <code>me@example.com----hunter2</code>. Alongside
              <code>{{ "{key}" }}</code>, <code>{{ "{value}" }}</code> and
              <code>{{ "{updatedAt}" }}</code>, any other name is a field of the
              value (<code>{{ "{a.b}" }}</code> reaches a field of a field), and
              <code>\t</code> / <code>\n</code> are a tab and a newline for a
              tab-separated file. A preview shows the lines before you download,
              so a mistyped field name reads as the empty column it would be, and
              the format is kept on the folder for next time.
            </p>
            <p class="help-note">
              Folder names and record keys may hold letters, digits, underscores
              and hyphens, so they can be written as a reference. Values are
              stored as they are typed, unencrypted, and travel in the full
              backup from Settings; a password only the backend should ever see
              belongs in Secrets instead.
            </p>
          </template>
        </div>
      </div>

      <!-- Settings -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">设置</div>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>默认时区</td>
                  <td>用于计算所有任务的时间窗口。</td>
                </tr>
                <tr>
                  <td>默认最大重试次数</td>
                  <td>任务失败后的重试次数。</td>
                </tr>
                <tr>
                  <td>每天仅运行一次</td>
                  <td>防止任务在 24 小时内重复运行。测试时可关闭。</td>
                </tr>
                <tr>
                  <td>任务错峰</td>
                  <td>
                    各任务执行时间自动错开的最小间隔分钟数（0–30，默认
                    2），0 表示关闭；已排定的任务在下次调度时生效。同一时刻最多并发执行
                    2 个任务，超出的任务自动排队依次执行。
                  </td>
                </tr>
                <tr>
                  <td>默认播放时长</td>
                  <td>未在任务中单独设置时，Emby 观看会话的默认时长（秒）。</td>
                </tr>
                <tr>
                  <td>设备名称</td>
                  <td>
                    发送给 Emby API 的设备标识（如 <code>Mac</code>），Emby
                    会在客户端旁显示该名称。
                  </td>
                </tr>
                <tr>
                  <td>默认用户代理</td>
                  <td>
                    未在任务中单独选择时使用的 UA 预设。从已有预设中选择，默认为
                    SenPlayer (Mac)。
                  </td>
                </tr>
                <tr>
                  <td>用户代理预设</td>
                  <td>
                    管理可在任务中选用的 UA 预设列表。内置
                    SenPlayer、Yamby、Hills、Lenna、VidHub
                    五个预设，可按需添加或删除。
                  </td>
                </tr>
                <tr>
                  <td>AI 服务商</td>
                  <td>
                    管理 AI 服务商和模型。全新安装已预置
                    OpenRouter（<code>https://openrouter.ai/api/v1</code>）及
                    <code>nvidia/nemotron-nano-12b-v2-vl:free</code>
                    模型，在此处填入 API 密钥即可启用
                    <code>{aiBtn}</code>、<code>{aiInput}</code>
                    和"输入验证码"功能。支持添加任意 OpenAI
                    兼容服务商，并可开启"报错时自动切换服务商"，在默认模型限速或出错时自动尝试其他已配置的服务商。默认模型下拉框精确对应到具体的"服务商 + 模型"记录，即使两个服务商提供同名模型也不会混淆。
                  </td>
                </tr>
                <tr>
                  <td>通知机器人 Token</td>
                  <td>
                    发送任务通知的机器人 Token（<code>@BotFather</code> →
                    <code>/newbot</code>）。仅以掩码回显，留空即保留原值。
                  </td>
                </tr>
                <tr>
                  <td>通知默认目标</td>
                  <td>
                    机器人发送通知的目标：数字 Chat ID，或频道／群组的
                    <code>@名称</code>。可用"查找会话"从机器人最近的对话中选取。
                  </td>
                </tr>
                <tr>
                  <td>通知触发时机</td>
                  <td>选择触发通知的事件：失败（默认）和/或成功，可多选。</td>
                </tr>
                <tr>
                  <td>通知目标用户名（已弃用）</td>
                  <td>
                    未配置机器人 Token 时，由任务关联账号发送通知的目标，接受
                    <code>username</code>、<code>@username</code> 或
                    <code>https://t.me/username</code
                    >。未填写时发至账户"收藏夹"。该方式将在后续版本中移除。
                  </td>
                </tr>
                <tr>
                  <td>TG 应用客户端</td>
                  <td>
                    管理 Telegram
                    会话的设备信息预设。"账号默认客户端"可设为"使用默认"（指定某个预设为默认）或"随机选择"（无指定客户端的账号每次连接随机使用一个预设）。设备型号支持
                    <code>{name}</code>、<code>{tgName}</code>、<code>{tgUsername}</code>、<code>{id}</code>
                    及随机 <code>{word:4}</code>、<code>{num:4}</code>、<code>{alpha:8}</code>、<code>{uuid}</code>
                    变量，随机值按账户固定，使每个账户拥有唯一的设备名称。
                  </td>
                </tr>
                <tr>
                  <td>TG 账号显示</td>
                  <td>
                    开启后，引用账户的位置（消息、任务、模板）将以「Bemby 账户名 - TG 账号名」形式显示。
                  </td>
                </tr>
                <tr>
                  <td>账号导出 / 导入</td>
                  <td>
                    将 Telegram 会话数据导出为 JSON 文件，可导入至另一 Bemby
                    实例，无需重新认证。
                  </td>
                </tr>
                <tr>
                  <td>默认 TG API 凭据</td>
                  <td>
                    统一配置全局 API ID 和 Hash；无独立凭据的账号自动使用全局默认值。Hash 在界面中始终脱敏显示。
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-para" style="margin-top: 14px">
              <strong>管理员凭据</strong> --
              随时更改管理员用户名或密码，确认更改时需输入当前密码。
              使用默认密码（<code>changeme</code>）登录时，系统将强制要求更改密码后方可继续访问。
            </p>
            <p class="help-para" style="margin-top: 14px">
              <strong>内存使用</strong> -- 显示当前占用（RSS）、本次启动峰值、外部内存与可用上限。
              <strong>外部内存</strong>指缓冲区与下载内容，不计入 JS 堆，因此也不受
              <code>--max-old-space-size</code> 限制 --
              内存问题往往出现在这一项，而堆内存看起来完全正常。
            </p>
            <p class="help-note">
              占用超过上限的 75% 时，日志中会出现一条告警，并指出当时正在运行的任务。
            </p>
            <p class="help-note">
              进程因内存不足被系统强制终止时，来不及在日志中留下任何记录，只会突然中断。
              因此内存数据会定期写入数据库：下次启动时，若上次未正常退出，卡片顶部会显示上次退出前的占用量、
              外部内存以及当时正在运行的任务。若该数值接近上限，即可确认是内存不足导致；
              此时日志中对应的任务会显示为「被服务器重启中断」。正常停止或重启容器不会触发该提示。
            </p>
            <p class="help-note">
              在内存较小的机器（如 2GB）上，可通过环境变量降低占用：<code>TG_LIVE_CLIENT_MAX</code>
              限制同时保持的 Telegram 连接数，<code>TG_MEDIA_MAX_MB</code> 与
              <code>TG_UPLOAD_MAX_MB</code> 限制消息页面收发文件的大小，<code>NODE_OPTIONS</code>
              调整 Node 堆内存上限。详见 <code>env.example</code>。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Settings</div>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>Default Timezone</td>
                  <td>Used when calculating schedule windows for all jobs.</td>
                </tr>
                <tr>
                  <td>Default Max Retries</td>
                  <td>How many times a failed job attempt is retried.</td>
                </tr>
                <tr>
                  <td>Enforce one run per day</td>
                  <td>
                    Prevents a job from running more than once in a 24-hour
                    period. Disable during testing.
                  </td>
                </tr>
                <tr>
                  <td>Job Staggering</td>
                  <td>
                    Minimum minutes the scheduler keeps between different jobs'
                    run times (0–30, default 2). 0 disables;
                    already-scheduled jobs pick it up at their next scheduling.
                    At most 2 jobs execute at once — extras queue and run in
                    turn.
                  </td>
                </tr>
                <tr>
                  <td>Default Play Duration</td>
                  <td>
                    Fallback Emby Watch session length in seconds when not set
                    per-job.
                  </td>
                </tr>
                <tr>
                  <td>Device Name</td>
                  <td>
                    Device identifier sent to the Emby API (e.g.
                    <code>Mac</code>). Emby displays this alongside the client
                    name.
                  </td>
                </tr>
                <tr>
                  <td>Default User Agent</td>
                  <td>
                    The UA preset used when a job has no UA selected. Pick from
                    the preset list; defaults to SenPlayer (Mac).
                  </td>
                </tr>
                <tr>
                  <td>User Agent Presets</td>
                  <td>
                    Manage the preset list available in job forms. Five built-in
                    presets (SenPlayer, Yamby, Hills, Lenna, VidHub) — add or
                    remove custom entries as needed.
                  </td>
                </tr>
                <tr>
                  <td>AI Providers</td>
                  <td>
                    Manage AI suppliers and models. A fresh install
                    pre-configures OpenRouter
                    (<code>https://openrouter.ai/api/v1</code>) with the
                    <code>nvidia/nemotron-nano-12b-v2-vl:free</code> model — add
                    your API key here to activate <code>{aiBtn}</code>,
                    <code>{aiInput}</code>, and Enter Captcha. Any
                    OpenAI-compatible provider can be added, and an
                    "auto-fallback on error" toggle tries other configured
                    providers when the default model is rate-limited or errors.
                    The Default Model dropdown pins to an exact provider +
                    model combination, so two identically named models from
                    different providers are never confused.
                  </td>
                </tr>
                <tr>
                  <td>Notification Bot Token</td>
                  <td>
                    Token of the bot that sends job notifications
                    (<code>@BotFather</code> → <code>/newbot</code>). Only ever
                    echoed back masked; blank keeps the stored one.
                  </td>
                </tr>
                <tr>
                  <td>Notification Default Target</td>
                  <td>
                    Where the bot sends: a numeric chat ID, or a channel's /
                    group's <code>@name</code>. "Find chats" picks one off the
                    bot's recent conversations.
                  </td>
                </tr>
                <tr>
                  <td>Notify On Events</td>
                  <td>
                    Which events trigger a notification: failed (default) and/or
                    success. Multi-select.
                  </td>
                </tr>
                <tr>
                  <td>TG Notification Target (deprecated)</td>
                  <td>
                    With no bot token set, where the job's own account sends.
                    Accepts <code>username</code>, <code>@username</code>, or
                    <code>https://t.me/username</code>, falling back to Saved
                    Messages. This sender will be removed in a future release.
                  </td>
                </tr>
                <tr>
                  <td>TG App Clients</td>
                  <td>
                    Manage device fingerprint presets for Telegram sessions. The
                    "Default client for accounts" toggle switches between a
                    fixed default and random selection -- in random mode,
                    accounts with no explicit client pick one at random from all
                    configured presets on each connection. The Device Model
                    supports <code>{name}</code>, <code>{tgName}</code>,
                    <code>{tgUsername}</code>, <code>{id}</code>, and random
                    <code>{word:4}</code>, <code>{num:4}</code>,
                    <code>{alpha:8}</code>, <code>{uuid}</code> variables; random
                    values stay fixed per account, giving each account a unique
                    device name.
                  </td>
                </tr>
                <tr>
                  <td>TG Account Display</td>
                  <td>
                    When enabled, places that refer to an account (messenger,
                    jobs, templates) show it as "{Bemby name} - {TG name}".
                  </td>
                </tr>
                <tr>
                  <td>Account Export / Import</td>
                  <td>
                    Export Telegram session data as a JSON file. Import it into
                    another Bemby instance to transfer accounts without
                    re-authenticating.
                  </td>
                </tr>
                <tr>
                  <td>Default TG API Credentials</td>
                  <td>
                    Set a global API ID and Hash; accounts without their own
                    credentials fall back to these defaults. The Hash is always
                    masked in the UI.
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-para" style="margin-top: 14px">
              <strong>Admin Credentials</strong> -- change the admin username or
              password at any time. Current password is always required to
              confirm the change. If the default password (<code>changeme</code>)
              is still in use, the app forces a password change on next login
              before any other page is accessible.
            </p>
            <p class="help-para" style="margin-top: 14px">
              <strong>Memory Usage</strong> -- shows current usage (RSS), the
              peak for this run, external memory, and the available limit.
              <strong>External</strong> is buffers and downloads. It sits outside
              the JS heap, so <code>--max-old-space-size</code> does not bound it
              -- memory trouble usually shows up here while the heap looks
              perfectly normal.
            </p>
            <p class="help-note">
              Passing 75% of the limit writes a warning to the log, naming the
              job that was running at the time.
            </p>
            <p class="help-note">
              A process killed by the system for running out of memory gets no
              chance to record it -- the log simply stops. Readings are therefore
              written to the database periodically, and if the previous process
              did not exit cleanly the card shows how much it was holding, its
              external memory, and which job was running. A figure near the limit
              confirms it ran out of memory; the affected runs appear in the log
              as "Interrupted by server restart". Stopping or restarting the
              container normally does not trigger this notice.
            </p>
            <p class="help-note">
              On a small machine (2GB, say) these environment variables reduce
              usage: <code>TG_LIVE_CLIENT_MAX</code> bounds how many Telegram
              connections are held at once, <code>TG_MEDIA_MAX_MB</code> and
              <code>TG_UPLOAD_MAX_MB</code> bound the size of files received and
              sent in the Messenger, and <code>NODE_OPTIONS</code> sets the Node
              heap ceiling. See <code>env.example</code> for the full list.
            </p>
          </template>
        </div>
      </div>

      <!-- Logs -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">日志</div>
            <p class="help-para">
              每次任务执行均记录时间戳、状态和消息。
              使用顶部的任务下拉筛选器按任务缩小范围，或在文本搜索框中输入关键词，对任务名称、账号名称或消息内容进行模糊筛选。
              日志列表每次加载最多显示 50 条记录（最新在前），点击底部的<strong>加载更多</strong>按钮可继续加载更早的记录。
            </p>
            <div class="help-badges-row">
              <span class="badge badge-green">成功</span>
              <span class="badge badge-red">失败</span>
              <span class="badge badge-orange">运行中</span>
            </div>
            <p class="help-para" style="margin-top: 10px">
              <strong>签到任务详情</strong>
            </p>
            <p class="help-para">
              点击任意签到日志行可展开仿 Telegram
              气泡样式的对话详情，显示完整的交互过程：
            </p>
            <ol class="help-steps">
              <li>右侧绿色气泡显示发送的命令（含模板展开后的实际内容）。</li>
              <li>
                左侧灰色气泡显示机器人回复（图片、文字、网页预览）及内联键盘，已点击的按钮以绿色高亮。
              </li>
              <li>右侧绿色气泡显示实际点击的按钮文字。</li>
              <li>
                若机器人在按钮点击后有响应（原地编辑或发送新消息），左侧会再显示一个响应气泡。
              </li>
              <li>若有多次重试，每次尝试均单独展示。</li>
            </ol>
            <p class="help-note">
              使用 <code>{aiBtn}</code> 时，点击气泡下方会显示
              <strong>AI · Xms</strong> 标识，表示 AI 选择所用时长。
            </p>
            <p class="help-note">
              对于状态为<strong>运行中</strong>的任务，详情面板每秒自动刷新，可实时查看步骤进展。
              可点击消息列的<strong>停止</strong>按钮随时中止正在运行的任务。若任务因升级或重启而卡在<strong>运行中</strong>（对应进程已不存在），点击停止会将其强制标记为失败以便清理；重启后残留的运行中记录也会自动标记为失败。
            </p>
            <p class="help-para" style="margin-top: 10px">
              <strong>Emby 观看任务详情</strong>
            </p>
            <p class="help-para">
              点击任意 Emby 观看日志行可展开播放摘要卡片，显示以下信息：
              内容名称（及剧集信息）、剧集总时长、播放起始与结束位置、实际观看时长、是否已标记为已看；启用<strong>真实观看</strong>时另显示<strong>已串流</strong>的数据量。
              启用<strong>顺序播放</strong>时，卡片会列出本次按顺序播放的每一集，并显示<strong>顺序播放集数</strong>与<strong>总观看时长</strong>。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              重跑失败任务
            </div>
            <p class="help-para">
              对于状态为<strong>失败</strong>的执行记录，可在日志视图中点击重跑按钮，立即重新运行对应任务。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              归档日志
            </div>
            <p class="help-para">
              点击非运行中日志行右侧的归档图标，可将该记录软隐藏（不删除数据）。
              归档记录默认不显示；开启列表顶部的<strong>显示已移除</strong>开关可查看所有归档记录。
              点击还原图标可取消归档。
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              开发者日志
            </div>
            <p class="help-para">
              日志列表顶部有<strong>开发者</strong>开关，开启后可查看以下调试信息：
            </p>
            <ul class="help-steps">
              <li>
                <strong>签到任务</strong>：TG
                连接耗时、等待回复耗时（含配置的超时限制）、按钮 API
                调用耗时、按钮响应耗时及来源（原地编辑或新消息）、总耗时、错误类型。
              </li>
              <li>
                <strong>自定义任务</strong
                >：每步收到的消息数（等待回复步骤）、响应来源、重试次数（点击按钮步骤）及错误类型。
              </li>
              <li>
                <strong>自定义任务</strong
                >（进阶元数据）：每步收到的消息数、响应来源、重试次数及错误类型。AI
                提示词、响应及耗时无论是否开启此开关均始终显示在步骤日志中。
              </li>
            </ul>
            <p class="help-note">默认关闭，调试或调优任务参数时开启。</p>
            <p class="help-para" style="margin-top: 10px">
              <strong>AI 调试面板</strong>
            </p>
            <p class="help-para">
              自定义任务日志中，含有 AI 步骤（<code>{aiBtn}</code>、<code
                >{aiInput}</code
              >
              或"输入验证码"）的步骤标题旁会显示一个烧杯图标。
              点击即可打开调试面板，支持：修改提示词、查看发送给 AI
              的图片、调整最大 token 数，然后点击<strong>执行</strong>，
              实时查看 AI
              返回的原始响应。可反复调试直到提示词满意，无需重新运行整个任务。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Logs</div>
            <p class="help-para">
              Every job execution is recorded with a timestamp, status, and
              message. Use the job dropdown to filter by a specific job, or type
              in the search box to fuzzy-match across job name, account name,
              and message. The list loads the 50 most recent records; click
              <strong>Load More</strong> at the bottom to fetch older entries.
            </p>
            <div class="help-badges-row">
              <span class="badge badge-green">Success</span>
              <span class="badge badge-red">Failed</span>
              <span class="badge badge-orange">Running</span>
            </div>
            <p class="help-para" style="margin-top: 10px">
              <strong>Check-in detail view</strong>
            </p>
            <p class="help-para">
              Click any check-in log row to expand a Telegram-style chat view
              showing the full interaction:
            </p>
            <ol class="help-steps">
              <li>
                A green bubble on the right shows the command that was sent
                (with any template placeholders already expanded).
              </li>
              <li>
                A grey bubble on the left shows the bot's reply -- photo, text,
                web preview -- with the inline keyboard below it. The clicked
                button is highlighted green.
              </li>
              <li>
                A green bubble on the right shows which button was clicked.
              </li>
              <li>
                If the bot responded after the button click -- whether by
                editing its original message or sending a new one -- the
                response appears as a second grey bubble on the left.
              </li>
              <li>If the job retried, each attempt is shown separately.</li>
            </ol>
            <p class="help-note">
              When <code>{aiBtn}</code> is used, an
              <strong>AI · Xms</strong> badge appears below the clicked button
              bubble, showing how long the AI took to pick.
            </p>
            <p class="help-note">
              While a job is <strong>Running</strong>, the detail panel
              refreshes automatically every second so you can watch steps
              complete in real time. Click the <strong>Stop</strong> button in
              the message column to cancel a running job at any time. If a job is
              stuck in <strong>Running</strong> after an upgrade or restart (its
              underlying process no longer exists), Stop force-marks it as failed
              so it can be cleared; leftover running entries are also
              automatically marked failed on restart.
            </p>
            <p class="help-para" style="margin-top: 10px">
              <strong>Emby Watch detail view</strong>
            </p>
            <p class="help-para">
              Click any Emby Watch log row to expand a playback summary card
              showing: content title (and series/episode info), total runtime,
              start and end positions, actual duration watched, and whether the
              item was marked as watched. With <strong>Real Watch</strong> on it
              also shows how much was <strong>Streamed</strong>. With
              <strong>Sequence Play</strong> on, the card lists every episode
              played in order, plus <strong>Episodes played</strong> and
              <strong>Total watched</strong>.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Rerun failed jobs
            </div>
            <p class="help-para">
              For any execution with a <strong>Failed</strong> status, click the
              rerun button in the log view to run the corresponding job again
              immediately.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Archiving logs
            </div>
            <p class="help-para">
              Click the archive icon on any non-running log row to soft-hide it
              without deleting the data. Archived records are hidden by default;
              toggle <strong>Show Retired</strong> at the top of the list to
              include them. Click the restore icon to un-archive.
            </p>

            <div
              class="card-section-title"
              style="margin-top: 16px; font-size: 11px"
            >
              Developer Logs
            </div>
            <p class="help-para">
              Toggle <strong>DEV</strong> at the top of the log list to reveal
              additional diagnostic data:
            </p>
            <ul class="help-steps">
              <li>
                <strong>Check-in jobs</strong>: TG connect time, reply latency
                (with the configured timeout limit for comparison), button click
                API time, button response time and source (edited message or new
                message), total attempt duration, and error type on failure.
              </li>
              <li>
                <strong>Custom jobs</strong>: per-step metadata including
                message count received (wait-reply steps), response source and
                retry count (click-button steps), and error type.
              </li>
              <li>
                <strong>AI steps</strong>: per-step message count (wait-reply),
                response source and retry count (click-button), and error type.
                AI prompt, response, and timing are always visible in the step
                log regardless of this toggle.
              </li>
            </ul>
            <p class="help-note">
              Off by default. Enable when debugging failures or tuning timeout
              and retry settings.
            </p>
            <p class="help-para" style="margin-top: 10px">
              <strong>AI Debug Panel</strong>
            </p>
            <p class="help-para">
              Any custom job step that involved AI (<code>{aiBtn}</code>,
              <code>{aiInput}</code>, or Enter captcha) shows a flask icon next
              to the step header. Click it to open the debug panel: edit the
              prompt, inspect the image that was sent, adjust max tokens, then
              click <strong>Run</strong> to call the AI live and see the raw
              response. Iterate on the prompt as many times as needed without
              re-running the whole job.
            </p>
          </template>
        </div>
      </div>

      <!-- Notifications -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">通知</div>
            <p class="help-para">
              任务结束时由 Telegram 机器人发送通知，在<strong>设置</strong>页面的"TG
              通知"板块配置。由机器人发送意味着不依赖任务关联账号是否已登录，因此没有关联账号的任务同样能收到通知。
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>机器人 Token</td>
                  <td>
                    在 Telegram 中打开
                    <code>@BotFather</code>，发送
                    <code>/newbot</code>，设置名称与用户名，复制返回的
                    Token（形如
                    <code>123456789:AAH…</code>）；已有机器人可用
                    <code>/mybots</code> 或 <code>/token</code>
                    重新获取。保存后仅以掩码回显，留空即保留原值。
                  </td>
                </tr>
                <tr>
                  <td>默认目标</td>
                  <td>
                    数字 Chat ID，或频道／群组的
                    <code>@名称</code>。机器人无法主动发起对话：请先给机器人发送任意消息，再点击<strong>查找会话</strong>从它最近的对话中选取
                    Chat ID；频道或群组需先将机器人加入。
                  </td>
                </tr>
                <tr>
                  <td>通知时机</td>
                  <td>
                    选择触发通知的事件：<strong>任务失败</strong>（默认勾选）和/或<strong>任务成功</strong>，可多选。
                  </td>
                </tr>
                <tr>
                  <td>发送测试</td>
                  <td>
                    立即发送一条真实通知，是同时验证 Token、网络可达性与目标是否有效的唯一方式。字段中未保存的 Token 与目标也会被采用，便于先试后存。
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">用户主动中止的任务不触发失败通知。</p>
            <p class="help-note">
              未配置 Token 时沿用旧方式：由任务关联账号自行发送（未填目标时发至"收藏夹"）。该方式<strong>已弃用</strong>，将在后续版本中移除——它需要为每条通知建立一次完整的
              MTProto 连接，且仅在该账号已登录时可用。请在<strong>设置</strong>中改用机器人 Token。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Notifications</div>
            <p class="help-para">
              A Telegram bot sends a notification when a job finishes,
              configured in the <strong>Settings</strong> page under "TG
              Notifications". Sending as a bot means notifications do not depend
              on the job's account being authenticated, so a job with no linked
              account gets them too.
            </p>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>Bot Token</td>
                  <td>
                    Open <code>@BotFather</code> in Telegram, send
                    <code>/newbot</code>, choose a name and a username, and copy
                    the token it replies with (like
                    <code>123456789:AAH…</code>). For an existing bot,
                    <code>/mybots</code> or <code>/token</code> reissues it. The
                    stored token is only ever echoed back masked, and leaving the
                    field blank keeps it.
                  </td>
                </tr>
                <tr>
                  <td>Default Target</td>
                  <td>
                    A numeric chat ID, or a channel's / group's
                    <code>@name</code>. A bot cannot start a conversation, so
                    send your bot any message and then use
                    <strong>Find chats</strong> to pick the chat ID off its
                    recent conversations; a channel or group needs the bot added
                    to it first.
                  </td>
                </tr>
                <tr>
                  <td>Notify On Events</td>
                  <td>
                    Which events trigger a notification:
                    <strong>Failed</strong> (default) and/or
                    <strong>Success</strong>. Multi-select.
                  </td>
                </tr>
                <tr>
                  <td>Send test</td>
                  <td>
                    Sends a real notification now -- the only check that covers
                    the token, the host's reachability and the target at once. An
                    unsaved token or target in the fields is used, so either can
                    be tried before it is committed.
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="help-note">
              Jobs cancelled by the user do not trigger a failure notification.
            </p>
            <p class="help-note">
              With no token set the old sender still applies: the job's own
              account sends, falling back to Saved Messages when no target is
              configured. That sender is <strong>deprecated and will be removed
              in a future release</strong> -- it opens a full MTProto connection
              per notification and only works while that account is
              authenticated -- so move to a bot token in
              <strong>Settings</strong>.
            </p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { locale } from "../i18n";
import { dataStoreEnabled, loadDataStoreSetting } from "../composables/dataStore";
import { loadMsApiSetting, msApiAvailable } from "../composables/msApi";

// The Data card is only worth showing where the feature is switched on, and the msOauth2api
// sentences only where the deployment offers it
onMounted(() => {
  loadDataStoreSetting();
  void loadMsApiSetting();
});
</script>

<style scoped>
.help-para {
  color: #555;
  line-height: 1.7;
  margin-bottom: 10px;
}

.help-steps {
  color: #555;
  line-height: 1.9;
  padding-left: 20px;
  margin-top: 10px;
}

.help-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}

.help-table td {
  padding: 7px 10px;
  vertical-align: top;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
  color: #444;
}

.help-table td:first-child {
  font-weight: 600;
  width: 180px;
  color: #222;
  white-space: nowrap;
}

.help-badges-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.help-note {
  font-size: 12px;
  color: #888;
  line-height: 1.6;
  margin-top: 6px;
}

code {
  font-family: "SFMono-Regular", Consolas, monospace;
  background: #f0f2f5;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
</style>
