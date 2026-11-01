# 本机 Node 进程怎么发 macOS 用户通知

> 调研票：xxh171015/afk-platform#128（地图 #125）。调研日期：2026-11-01。
> 只做了文档、系统词典、SDK 头文件和开源仓库源码调查。本机是 macOS 26.2（Build 25C56）。用 `osascript` 测过**语法/参数错误**的退出码，**没有实际弹出过一条通知**。标「**未确认，需实测**」的项要在 PoC 机器上跑一遍。
> 不做渠道选择：第一期用不用 macOS、发哪些事件，留给 [#130](https://github.com/xxh171015/afk-platform/issues/130)。不查飞书 / Slack Webhook。

## 结论

本机 Node 进程（无 Electron、无自己的 Mac app）要发一条 Notification Center 用户通知，只有两条走得通的路，能力差一截。

1. **调用系统自带的 `/usr/bin/osascript`，跑 Standard Additions 的 `display notification`。** 不需要再带二进制，也不需要自己签一个 bundle。能设标题、正文、副标题、声音。命令本身没有「点击打开 URL」参数；点通知会打开**发通知的那个 app**（从终端调 `osascript` 时，身份落在 Script Editor / `osascript` 上，不是平台页面）。脚本编译失败或两个参数都空会同步非 0 退出；用户关了通知、开了 Focus、机器在睡，脚本仍然返回成功——展示失败是静默的。
2. **再带一个真正的 `.app` bundle，走 `UNUserNotificationCenter`。** 现成的是 `terminal-notifier` 3.x（`node-notifier` 在 Darwin 上就是 spawn 它捆绑的那份）。这条路支持点击后 `NSWorkspace` 打开带 scheme 的 URL（PoC 的 `http://127.0.0.1:...` 合法）。权限拒绝、无 GUI session、投递失败有同步退出码。它**就是**一个额外的 Mac app：`UNUserNotificationCenter` 的 SDK 头写明是「当前 application」的对象，图标和 TCC 身份都来自这个 bundle 的签名。下载的未公证包会被隔离；Homebrew / `make install` 不受 quarantine。`-ignoreDnD` 没有 Apple 批的 time-sensitive entitlement，实际上是空操作。Focus / 定时摘要仍会静默压掉横幅。

Node 自己 `dlopen` UserNotifications.framework、或把平台 API 进程当成裸可执行文件去调 `currentNotificationCenter`，官方 API 不支持：头文件把 center 定义成「当前 application」的，delegate「只能从 application 设置」。这不是「多写几行 Node」能绕开的。

机器休眠时用户进程被挂起，即时发送做不到；已经交给系统的定时通知由 macOS 持有，壳进程退出后仍可能到点投递。睡眠当中横幅会不会亮、还是要等唤醒，Apple 文档没写。Docker Linux 容器里没有这套 API。和 Docker Desktop 同机、但跑在用户 Aqua 会话里的宿主机 Node 进程，身份上就是普通终端进程，并不继承 Docker Desktop 的通知权限。

## 来源

| 编号 | 来源 | 取得日期 / 版本 |
| --- | --- | --- |
| [ASLR] | https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html（`display notification`） | 2026-11-01 抓取 |
| [MASG] | https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html | 2026-11-01 |
| [RN109] | https://developer.apple.com/library/archive/releasenotes/AppleScript/RN-AppleScript/RN-10_9/RN-10_9.html | 2026-11-01 |
| [SDEF] | 本机 `/System/Library/ScriptingAdditions/StandardAdditions.osax` 的 `sdef`（`display notification`，code `sysonotf`） | 2026-11-01，macOS 26.2 |
| [OSA] | `man osascript`（Darwin，日期 April 24, 2014） | 2026-11-01 本机 |
| [OSAC] | `man osacompile` | 2026-11-01 本机 |
| [OSA-BIN] | 本机 `/usr/bin/osascript`：`codesign -dv`、`--entitlements`、嵌入的 Info.plist | 2026-11-01，CFBundleIdentifier `com.apple.osascript`，entitlement `com.apple.developer.notificationcenter-identifiers` = `com.apple.ScriptEditor2` |
| [UN] | https://developer.apple.com/documentation/usernotifications/unusernotificationcenter.md | 2026-11-01 |
| [UN-AUTH] | https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:).md | 2026-11-01 |
| [UN-ASK] | https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications.md | 2026-11-01 |
| [UN-SCHED] | https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app.md | 2026-11-01 |
| [UN-ADD] | https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/add(_:withcompletionhandler:).md | 2026-11-01 |
| [UN-CONTENT] | https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent.md | 2026-11-01 |
| [UN-ERR] | https://developer.apple.com/documentation/usernotifications/unerror/code.md | 2026-11-01 |
| [UN-IL] | https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel.md | 2026-11-01 |
| [UN-OPT] | https://developer.apple.com/documentation/usernotifications/unauthorizationoptions.md | 2026-11-01 |
| [UN-PRES] | https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:willpresent:withcompletionhandler:).md | 2026-11-01 |
| [UN-ACT] | https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions.md | 2026-11-01 |
| [UN-SET] | https://developer.apple.com/documentation/usernotifications/unnotificationsettings.md | 2026-11-01 |
| [UN-H] | Xcode SDK `UserNotifications.framework/Headers/UNUserNotificationCenter.h` | 2026-11-01 本机 SDK |
| [NSUN] | SDK `Foundation.framework/Headers/NSUserNotification.h`（`API_DEPRECATED(..., macos(10.8, 11.0))`） | 2026-11-01 |
| [WWDC21] | https://developer.apple.com/videos/play/wwdc2021/10091/（Time Sensitive / Focus / 四种 interruption level） | 2026-11-01 |
| [CFBID] | https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleidentifier.md | 2026-11-01 |
| [TN2083] | https://developer.apple.com/library/archive/technotes/tn2083/_index.html（Daemons and Agents） | 2026-11-01 |
| [DAEMON] | https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html | 2026-11-01 |
| [LAUNCH] | https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html | 2026-11-01 |
| [TCC] | `man tccutil` | 2026-11-01 本机 |
| [ENERGY] | https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheAppLevel.html | 2026-11-01 |
| [PMSET] | `man pmset` | 2026-11-01 本机 |
| [OPEN] | `man open` | 2026-11-01 本机 |
| [TN] | https://github.com/julienXX/terminal-notifier/blob/master/README.markdown | 2026-11-01，要求 macOS ≥ 10.14 |
| [TN-SRC] | https://github.com/julienXX/terminal-notifier/blob/master/Terminal%20Notifier/AppDelegate.m | 2026-11-01 源码 |
| [NN] | https://github.com/mikaelbr/node-notifier/blob/master/README.md | 2026-11-01，包版本 12.1.0 |
| [NN-SRC] | https://github.com/mikaelbr/node-notifier/blob/master/src/notifiers/notificationcenter.ts、`src/index.ts`、`src/lib/vendor.ts`、`package.json` | 2026-11-01 |
| [ENG] | 本仓库 worktree 根 `package.json` `"node": ">=22.18"` | 2026-11-01 |

本机实验：`osascript -e 'display notifcation "x"'` 语法错误退出码 1；`osascript -e 'display notification'`（标题和正文都空）执行错误 `-50`，退出码 1。没有发过真实通知。

## 1. `osascript` 的 `display notification`

**事实**

- 命令来自系统的 Standard Additions，不是 `osascript` 自己发明的。本机 sdef：`display notification`（code `sysonotf`），直接参数是正文（可选），另有 `with title`、`subtitle`、`sound name`，都是可选文本。说明写着：正文和标题至少要有一个；标题缺省是「调用方应用的名字」[SDEF]。
- AppleScript Language Guide：把通知发到 Notification Center，可带标题、副标题、说明、声音。结果是 **None**。展示方式完全由系统「通知」偏好控制：用户可以改成精简样式、关掉声音、或者根本不显示 [ASLR]。
- OS X 10.9 起 Standard Additions 才有这条命令 [RN109]。
- 调用方式：`osascript` 执行 OSA 脚本。`-e` 逐行传入；默认语言是 AppleScript；脚本错误默认打到 stderr [OSA]。本机二进制是 `/usr/bin/osascript`，Apple 平台签名，Info.plist 里 `CFBundleIdentifier` = `com.apple.osascript`，`CFBundleName` = `osascript`。它带私有 entitlement `com.apple.developer.notificationcenter-identifiers`，值为 `com.apple.ScriptEditor2` [OSA-BIN]。也就是说从终端跑 `osascript -e 'display notification …'`，Notification Center 把这条通知记在 Script Editor 那一套身份上，而不是记在 Node 或平台 API 上。
- Mac Automation Scripting Guide：跑过一次之后，**脚本本身或 Script Editor**（从 Script Editor 里跑时）会出现在系统通知设置的应用列表里，用户可以在那里改横幅/提醒。点提醒样式的 Show，会打开**发这条通知的那个 app**。如果发的是脚本 app，再次打开会再跑一遍 `run` handler [MASG]。Guide 没有「打开任意 URL」参数。
- Node 侧就是 `child_process.execFile('/usr/bin/osascript', ['-e', 'display notification "正文" with title "标题"'])`（或等价的 `spawn`）。不需要 npm 包，不需要自己的 bundle，不需要 Developer ID。
- 同步错误：脚本编译失败或运行时错误时，`osascript` 把错误写到 stderr 并以非 0 退出 [OSA]。本机：两个参数都空 → `execution error: 参数错误。 (-50)`，退出码 1。Guide 写结果是 None，所以**成功执行不代表用户看见了横幅** [ASLR]。
- 没有点击打开 URL、没有自定义 action、没有把通知归到自己的 bundle 名下的官方参数 [SDEF][ASLR]。
- 若把脚本编成 applet：`osacompile` 可以打出捆绑的 applet/droplet [OSAC]。那就是「额外的 Mac app」。点通知会打开这个 applet 并再跑 `run` [MASG]。票面约束是无额外 Mac app，这条只作为对照。

**失败模式**

| 情况 | 调用方能不能同步知道 |
| --- | --- |
| AppleScript 语法错、标题和正文都空 | 能：stderr + 非 0 |
| 用户从未授权 / 在设置里关掉了 Script Editor（或 osascript）的通知 | 不能：命令仍成功，展示由偏好决定 [ASLR] |
| Focus / 勿扰 / 定时摘要把横幅吃掉 | 不能（命令没有 Focus API） |
| 无 Aqua GUI session（SSH、以 root 跑的 launchd） | **未确认，需实测**。Apple 没给 `display notification` 单独的 session 文档；terminal-notifier 在同样环境下会 10 秒后失败（见 §2） |
| 机器正在睡 | 进程被挂起，这条命令当时跑不了（见 §6） |

**未确认，需实测**

- 本机 macOS 26.2 上，从 Terminal / LaunchAgent / 纯 Node `execFile` 发出去的横幅，设置里到底显示成「osascript」还是「Script Editor」。entitlement 指向 `com.apple.ScriptEditor2`，Guide 说列表里会出现脚本或 Script Editor，两份来源不完全同词。
- 点横幅会不会打开 Script Editor、会不会什么都不做。Guide 只保证「打开发通知的那个 app」。
- 未授权时 `display notification` 会不会弹出系统权限框，还是直接静默。Guide 只说用过之后会出现在通知设置列表里 [MASG]，没有写第一次是否 prompt。

## 2. `terminal-notifier`（UserNotifications 的命令行壳）

**事实**

- 项目说明：从命令行发 macOS User Notifications；要求 macOS 10.14+（因为要用 `UNUserNotificationCenter`，该 API 之前不存在）。3.x 把已弃用的 `NSUserNotification` 换成了 UserNotifications.framework [TN]。
- **必须是 app bundle，不能是裸可执行文件。** README：「A notification is attributed to an application, so the terminal-notifier ships as an app bundle rather than a bare executable。」调用下载来的包时，跑的是 `terminal-notifier.app/Contents/MacOS/terminal-notifier` [TN]。
- 签名：`make app` 产出 universal、**ad-hoc signed** 的 bundle。作者明确不公证；浏览器下载的会带 quarantine，第一次被拦，需要 `xattr -dr com.apple.quarantine`。Homebrew 和 `make install` 不带 quarantine [TN]。
- 身份不可伪造。3.0.0 删了 `-sender`：以前靠运行时改自己的 bundle id，`UNUserNotificationCenter` 读的是**真实的签名身份**，改不了。`-appIcon` 同样删了：公开 API 里通知内容没有图标字段，图标永远来自发通知的 bundle [TN][TN-SRC]。
- 怎么发：组 `UNMutableNotificationContent`（title / subtitle / body / sound），可选 category（按钮、回复），把 `-open` / `-execute` / `-activate` 写进 `content.userInfo`，`trigger:nil` 表示马上投递，然后 `addNotificationRequest:withCompletionHandler:` [TN-SRC]。这就是 Apple 的本地通知调度 API [UN-ADD][UN-SCHED]。
- 第一次会走 `requestAuthorizationWithOptions:`（alert + sound）。已拒绝则 stderr 说明并 `exit 3`。`add` 失败时，若 domain 是 `UNErrorDomain` 且 code 是 `UNErrorCodeNotificationsNotAllowed`，同样 `exit 3`；其他投递失败 `exit 5` [TN-SRC][UN-ERR]。
- 点击打开 URL：`-open URL`，要有 scheme（`https://…`、`file:///…`、自定义 scheme 都可以，包括没有 host 的 `mailto:`）。点通知体时，macOS **用无参数重新拉起这个 bundle**，在 `applicationDidFinishLaunching` 之后投递 `UNNotificationResponse`；handler 里 `[[NSWorkspace sharedWorkspace] openURL:]`。源码注释写在 macOS 26 上验证过：无参数启动必须再留几秒，否则 `-open`/`-execute`/`-activate` 根本跑不到 [TN][TN-SRC]。`-open` / `-execute` / `-activate` 的结果写系统日志，不写这次调用的 stdout [TN]。
- 无 GUI session：内部 10 秒 watchdog。超时 stderr：「This usually means no GUI session is available — for example when running over SSH, or from launchd as root. Notifications can only be posted for a logged-in user。」然后 `exit 4` [TN-SRC][TN]。
- Focus：README 把「A Focus mode is on」列为通知不出现的常见原因，**静默抑制**。`-ignoreDnD` 在 3.0.0 实质删除：以前是私有 flag；公开等价物是 time-sensitive interruption level，需要 Apple 批的 entitlement，发行包没有，选项被接受但什么都不做 [TN]。源码在 macOS 12+ 上仍会把 `interruptionLevel` 设成 `UNNotificationInterruptionLevelTimeSensitive` [TN-SRC]，但没有 entitlement 时系统不会按 time-sensitive 突破 Focus（见 §5）。
- 定时摘要：`-diagnose` 会读 `scheduledDeliverySetting`（macOS 12+），开着则提示通知可能被收进摘要 [TN-SRC][UN-SET]。
- 退出码 [TN][TN-SRC]：

  | 码 | 含义 |
  | --- | --- |
  | 0 | 成功（请求已交给系统；不保证用户看见） |
  | 1 | 用法错误 |
  | 2 | 参数无效（例如 `-open` 没有 scheme） |
  | 3 | 未授权 |
  | 4 | 联系通知服务超时（通常没有 GUI session） |
  | 5 | 通知服务拒绝请求 |
  | 6 | 等 `-action`/`-reply` 超时 |

- 源码在 `add` 成功之后立刻 `exit 0`：「The request is handed off and persisted at this point; presentation and sound are the notification service's job」[TN-SRC]。所以 **exit 0 ≠ 横幅已显示**。
- 自订图标 = 再拷一份 bundle（`make icon`），新的 bundle id，系统设置里单独一项，单独问一次权限 [TN]。那又是一个 Mac app。
- 定时：`-in` / `-at` 把请求交给 macOS 后进程退出；壳已经没了通知仍可能到达。`-open` 等点击动作存在通知里，到点再点仍然会跑；`-execute` 跑在**图形会话**的环境里，不是调度时的那个 shell [TN]。

**对「无额外 Mac app」的含义**

`terminal-notifier.app` 就是一个额外的 Mac app。它可以不出现在 Dock 里、可以从 Node 里 spawn，但 Notification Center、TCC、点击回流都认这个 bundle。没有它，`UNUserNotificationCenter` 这条路在官方 API 下不存在（见 §3）。

## 3. `UNUserNotificationCenter`（官方 API）

**事实**

- 共享对象管理「你的 app 或 app extension」的通知行为：申请授权、声明 category、调度本地通知、处理点击、读设置 [UN]。SDK 头：`currentNotificationCenter` 的注释是「The UNUserNotificationCenter for the current application」；`delegate`「The delegate can only be set from an application」[UN-H]。
- macOS 上的 API 可用性：头文件标 `API_AVAILABLE(macos(10.14), …)` [UN-H]。老的 `NSUserNotification` / `NSUserNotificationCenter` 从 macOS 10.8 起到 11.0 **deprecated**，注释要求改用 UserNotifications.framework [NSUN]。terminal-notifier 3 换 API 就是因为这个 [TN]。
- 发一条本地通知的步骤 [UN-SCHED][UN-CONTENT][UN-ADD]：
  1. `UNMutableNotificationContent`：`title`、`subtitle`、`body`、可选 `sound`、`userInfo`、`interruptionLevel`、`filterCriteria`、`threadIdentifier`、`categoryIdentifier`。
  2. trigger：`UNTimeIntervalNotificationTrigger` / `UNCalendarNotificationTrigger` / `UNLocationNotificationTrigger`，或 **`nil` = 马上投递** [UN-ADD]。
  3. `UNNotificationRequest(identifier:content:trigger:)`。
  4. `UNUserNotificationCenter.current().add(request)`。completion / `throws` 只表示**调度**成功或失败。
- 授权：有用户交互（alert / sound / badge）就必须先 `requestAuthorization`。第一次系统会问；以后用存下来的答案，不再弹。用户随时能在系统设置里改。要以当前设置为准，用 `getNotificationSettings` [UN-AUTH][UN-ASK]。`granted == false` 包括拒绝和尚未决定；要精确状态得去读 settings [UN-AUTH]。
- 未授权时系统的行为：本地通知「总是导致用户交互」，「系统会忽略 app 未被授权的那些交互」[UN-CONTENT]。也就是 **`add` 成功仍可能什么都不给用户看**。`UNError.Code.notificationsNotAllowed` 是「Notifications aren’t allowed」[UN-ERR]，terminal-notifier 用它来区分权限问题和坏请求 [TN-SRC]；Apple 文档没有保证未授权时 `add` 一定返回这个错误，而不是静默忽略交互。
- 点击：用户点自定义 action 或系统默认交互时，系统把 `UNNotificationResponse` 交给发这条通知的 **app** 的 delegate。app 没在跑时，系统会在后台拉起它来处理。默认点通知体是 `UNNotificationDefaultActionIdentifier`（「用户启动了你的 app」）；明确关掉是 `UNNotificationDismissActionIdentifier` [UN-ACT]。URL **不是**内容对象上的字段；要打开平台页面，只能：
  - 把 URL 放进 `userInfo`，在 `didReceive` 里自己 `openURL`（terminal-notifier 就是这么做的）[TN-SRC][UN-CONTENT]；或
  - 注册 `UNNotificationAction`，同样在 delegate 里处理 [UN-ACT]。
  两条路都要求**被拉起的是那个 app bundle**。裸 Node 进程没有 LaunchServices 身份，系统没法把点击送回来。
- 前台：若 app 在前台且实现了 `willPresent`，必须在 completion 里声明要 banner / list / sound 还是静音。没实现这个方法等于 `UNNotificationPresentationOptionNone`（前台完全静音）。**完全不设 delegate** 时，系统按通知原来的 options 提醒 [UN-PRES]。CLI helper 如果很快退出，通常不算一直停在前台；terminal-notifier 仍实现了 `willPresent` 并请求 banner+list+sound，避免自己还在前台时被吃掉 [TN-SRC]。
- 没有「Node 官方绑定」。要从 Node 直接调，只能写 native addon / `ffi` 去调框架，而且进程必须是有 `CFBundleIdentifier` 的 application [CFBID][UN-H]。把平台 API 打成 LaunchAgent 用的**未捆绑**二进制，连 `currentNotificationCenter` 都拿不到——这是 API 形状，不是风格问题。

**失败模式**

| 情况 | 同步可见？ |
| --- | --- |
| `add` 调度失败（附件坏了、无内容等） | 能：completion 里的 `Error` [UN-ADD][UN-ERR] |
| 用户拒绝授权 | 申请时能（`granted == false` / settings）。之后 `add` 可能成功但交互被忽略 [UN-CONTENT] |
| Focus / 摘要 | `add` 仍成功；横幅可能没有。要用 settings / interruption level，见 §5 |
| 点击要打开 URL，但 helper app 已被删或 LaunchServices 找不到 | 通知还能显示；点击无动作或拉起失败。terminal-notifier 要求 bundle 仍装在 `/Applications` 或 `~/Applications`，`tccutil reset` 才解析得了 id [TN] |

## 4. Node 库（`node-notifier`）

**事实**

- `node-notifier` 12.1.0：Darwin 上默认 notifier 是 `NotificationCenter`，它包的是捆绑的 **terminal-notifier 3.0.0**（Intel / Apple silicon universal）[NN][NN-SRC]。`src/index.ts`：`os.type() === 'Darwin'` → `NotificationCenter`。路径是 `vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier` [NN-SRC]。
- 所以 §2 的全部事实（bundle、签名、权限、退出码、`-open`、Focus、无 GUI）都适用于「在 Node 里 `notifier.notify({ title, message, open })`」。库没有第二条 macOS 实现。
- 选项映射：`{ message, title, subtitle, sound, open, group, actions, reply, timeout, wait }` → `terminal-notifier` 的对应 flag。`open` 就是点击要打开的 URL [NN]。
- `icon` 在 macOS 上不支持。图标永远是发通知那个 app 的。要换图标得自己编一份 terminal-notifier，再用 `customPath` [NN]——又是一个 bundle。
- 引擎：`node-notifier` 12.1.0 声明 `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` [NN]。本仓库根 package.json 是 `"node": ">=22.18"` [ENG]。**22.18–22.22.1 满足仓库、不满足当前 node-notifier。** 这不是通知 API 的限制，是依赖选型时的版本钉。
- 错误：`utils.fileCommand` spawn 那个二进制；callback 的 `err` 带着 `execFile` 的退出码。非交互通知立刻 callback，**没有** click/timeout 事件。只有带 `actions` / `reply` 的才会等用户 [NN][NN-SRC]。exit 6 + stdout `@TIMEOUT` 被当成超时而不是硬错误 [NN-SRC]。
- README：macOS 第一次发通知时系统会要通知权限 [NN]。
- cron / PM2 / 服务：通知出现在**已登录用户的桌面**上，进程必须在该用户已登录时、以该用户跑。这段原文主要讲 Linux session bus 和 Windows SYSTEM 账号；macOS 细节以 §2 的 GUI session / §5 的 LaunchAgent 为准 [NN]。
- 默认导出 `withFallback: true`：macOS < 10.14 会掉到 Growl [NN-SRC]。PoC 目标机若是 10.14+，走的是 Notification Center，不是 Growl。

其它 Node 包（`node-mac-notifier` 等）最终也要碰 UserNotifications 或 spawn helper；没有「纯 JS、无 bundle」的官方通道。本票以 README 点名的 `node-notifier` 为准，没有把每个 fork 再核一遍。

## 5. 权限、Focus、进程从哪来

**通知权限**

- UserNotifications 路径：每个 **app bundle id** 单独授权。第一次 `requestAuthorization` 弹系统框；以后用存下来的决定 [UN-AUTH][UN-ASK]。用户可在系统设置 → 通知里改。`tccutil reset UserNotification <bundle_id>` 清掉该 bundle 的决定，下次再问 [TCC][TN]。
- `osascript` 路径：没有自己的请求 API。身份是 `com.apple.osascript`，通知 center 标识 entitlement 指到 Script Editor [OSA-BIN]。授权条目是系统给这条身份的，不是给 Node 项目的。
- 设置里能关的东西（`UNNotificationSettings`）：授权状态、alert、声音、Notification Center 列表、锁屏、预览、alert 样式（none / banner / alerts）、定时投递、time-sensitive [UN-SET]。alert 样式是**每个应用**的用户设置，不能按单条通知选 [TN]。
- 临时授权（provisional）：申请时带 `.provisional`，第一次不弹框，通知只进历史、不横幅不响。用户在通知上选保留或关掉之后状态才变 [UN-ASK]。osascript / 发行版 terminal-notifier 都没有走这条（terminal-notifier 只请求 alert+sound）[TN-SRC]。

**Focus / 勿扰 / 摘要**

- WWDC 2021：Focus 会过滤哪些通知能打断。四种 `UNNotificationInterruptionLevel` [WWDC21][UN-IL]：
  - `passive`：进列表，不亮屏、不响、不突破系统控制。
  - `active`（默认）：立即展示，可出声，**不**突破 Focus / 摘要。
  - `timeSensitive`：立即展示，**可以**突破摘要和 Focus（若用户允许）。
  - `critical`：再绕过静音开关；需要 Apple 批的 entitlement。
- time-sensitive：Xcode capability + 在 content 上设 interruption level。用户仍可关掉该 app 的 Time Sensitive，或关掉它的全部通知 [WWDC21]。SDK 里 `UNAuthorizationOptionTimeSensitive` 已 deprecated，注释是 `"Use time-sensitive entitlement"` [UN-H][UN-OPT]。发行版 terminal-notifier **没有**这个 entitlement [TN]。
- `filterCriteria` 用来让系统按当前 Focus 决定显不显示，文档指向 App Intents 的 `SetFocusFilterIntent` [UN-CONTENT]。osascript / 默认 terminal-notifier 都没用它。
- 定时摘要：settings 的 `scheduledDeliverySetting`；开着时通知可能被收进摘要而不是马上出现 [UN-SET][TN-SRC]。
- **结果：** 默认（active）通知在 Focus 下被静默压掉，调用方的 `add` / `osascript` / `exit 0` 仍然成功。没有公开、免 entitlement 的「强制打断勿扰」开关。

**普通终端 / LaunchAgent / 挨着 Docker Desktop 的进程，用户能不能看见**

按 Apple 对后台程序的分类，能不能碰 GUI 服务取决于 **session**，不取决于「磁盘上和 Docker Desktop 是不是邻居」。

| 怎么跑 | Session | 能不能往这台 Mac 的 Notification Center 投 |
| --- | --- | --- |
| 用户已 GUI 登录，从 Terminal / IDE 起的 Node | Aqua（GUI 登录会话） | 可以尝试。osascript / terminal-notifier 都设计成这种用法 [MASG][TN] |
| `~/Library/LaunchAgents` 或 `/Library/LaunchAgents`，默认或 `LimitLoadToSessionType=Aqua` | Aqua | Agent 跑在该用户的 GUI 会话里，**可以**连 window server。Apple 仍写「能显示 UI，但不推荐」[TN2083][DAEMON][LAUNCH]。用户退出 GUI 时 per-user launchd 给这些 agent 发 SIGTERM [LAUNCH] |
| LaunchAgent `LimitLoadToSessionType=Background` | 用户的 Background 域（SSH 会话也在这，不依赖 GUI 登录）[TN2083] | 不是 GUI bootstrap。terminal-notifier 把「from launchd as root / 无 GUI」列为超时失败 [TN-SRC]。osascript 在这种 session 里 **未确认** |
| LaunchAgent `StandardIO` | 非 GUI 登录（尤其是 SSH）[TN2083] | 同上 |
| `/Library/LaunchDaemons`（系统 daemon） | 系统上下文 | **不能**连 window server，不能展示 UI [TN2083][DAEMON] |
| SSH 进这台已有 GUI 登录的机器，起一个 Node | 另一个 per-session bootstrap，不是 GUI 那个 [TN2083] | terminal-notifier：无 GUI session → 超时 exit 4 [TN-SRC]。osascript **未确认** |
| Node 跑在 Docker **Linux 容器**里 | 不是 macOS 进程 | 没有 `/usr/bin/osascript`，没有 UserNotifications.framework。宿主机 Notification Center 不可达 |
| 宿主机 Node，和 Docker Desktop 同用户 Aqua 会话 | 就是第一行 | Docker Desktop 是另一个 app，有自己的 bundle 和通知权限。挨着它**不会**把权限或身份借给平台进程 |

「用户能不能看见」还要过：该身份的通知权限、Focus、摘要、alert 样式、Notification Center 是否在跑、机器是否醒着。terminal-notifier `-diagnose` 会打印授权、样式、声音、NotificationCenter 进程、定时摘要 [TN][TN-SRC]。

## 6. 内容：标题、正文、点击打开 URL；同步错误 vs 静默丢

**标题和正文**

| 通道 | 标题 | 正文 | 副标题 | 声音 |
| --- | --- | --- | --- | --- |
| `display notification` | `with title`（可选；默认调用方 app 名） | 直接参数（可选；与标题至少其一） | `subtitle` | `sound name`（`Library/Sounds` 的基名）[SDEF][ASLR] |
| `UNMutableNotificationContent` / terminal-notifier / node-notifier | `title`（terminal-notifier 默认 `Terminal`） | `body` / `-message`（terminal-notifier 必填，除非 stdin） | `subtitle` | `sound` [UN-CONTENT][TN][NN] |

macOS 11+ 上，通知**另外**会显示发送 app 的名字 [TN]。osascript 那条身份是 Script Editor / osascript [OSA-BIN][MASG]；terminal-notifier 就是它自己的 bundle 名。

**点击打开平台 URL**

- `display notification`：**不支持**。点的是「打开发通知的 app」[MASG][ASLR]。要把点击变成打开 `http://127.0.0.1:<port>/…`，得自己做 applet，在 `run` 里 `open` 那个 URL——那是额外 Mac app。
- `UNUserNotificationCenter`：内容对象没有 URL 字段 [UN-CONTENT]。标准做法是 `userInfo` + delegate 里 `NSWorkspace` / `open` [UN-ACT][OPEN]。系统拉起的是**发通知的 app**。
- terminal-notifier / node-notifier：`-open` / `{ open }`。值必须带 scheme；`http://127.0.0.1:…` 合法。点的时候 bundle 还要能被 LaunchServices 找到并拉起 [TN][TN-SRC]。打开失败时 helper 的那次 relaunch 以非 0 退出，**原来那个 Node `notify()` 已经 exit 0 了**，平台进程看不到这次失败（非交互路径不把点击写回 stdout）[TN][NN]。

**同步错误 vs 静默丢**

能同步失败的：

- osascript：脚本错、标题正文都空 [OSA][SDEF]；本机退出码 1。
- terminal-notifier / node-notifier：用法、坏 URL、未授权、无 GUI、`add` 失败（退出码 1–5）[TN][TN-SRC][NN-SRC]。
- 直接 `UNUserNotificationCenter.add`：completion 里的 `Error` [UN-ADD]。

会静默（调用方看来是成功）的：

- 用户关了该身份的通知，或 alert 样式为 None [ASLR][UN-CONTENT][UN-SET][TN-SRC]。
- Focus / 勿扰压掉 active 通知 [WWDC21][TN]。
- 定时摘要把通知收进摘要 [UN-SET][TN-SRC]。
- `add` / `display notification` 成功，但系统忽略未授权的交互 [UN-CONTENT]。
- 机器锁屏且该 app 的 `lockScreenSetting` 为 disabled：锁屏上看不见，列表里未必没有 [UN-SET]。
- 点击打开 URL 失败发生在 helper 被重新拉起之后，原 Node 进程已经不管了 [TN-SRC]。

`UNErrorCodeNotificationsNotAllowed` 是权限问题的同步信号，但只在框架选择报错而不是忽略交互时才会出现 [UN-ERR]。osascript **没有**对等的错误。

## 7. 约束：localhost、单用户、机器会睡

**PoC 只听 localhost、单用户**

- 通知是本机 Notification Center 的本地投递，不经过 APNs，不需要公网。和 API 只绑 `127.0.0.1` 不冲突。
- 点击打开 `http://127.0.0.1:<port>/…` 只要 helper 支持 `-open` 且 URL 带 scheme [TN][OPEN]。浏览器是否把用户带到还在跑的 PoC 页面，是产品问题，不是通知 API 问题。
- 通知按 **GUI 登录用户** 投。LaunchAgent 在 Aqua 下是「每个 GUI 登录会话一个实例」[TN2083][LAUNCH]。单用户 PoC 就是那一个 Aqua 会话。

**机器会休眠**

- 即时发送（`display notification`、`add` + `trigger:nil`、terminal-notifier 不带 `-in`/`-at`）需要当时有一个醒着的进程去调 API。系统睡眠时，用户进程被挂起；`pmset` 说明进程可以用 I/O Kit power assertion 覆盖睡眠，见 `caffeinate(8)` [PMSET][ENERGY]。**没有 assertion 的 Node worker 在睡眠期间发不出通知。** 醒了之后进程若还在，才能补发。
- 已经交给系统的定时通知（`UNTimeIntervalNotificationTrigger` / terminal-notifier `-in`/`-at`）由 macOS 持有，调度进程可以退出 [UN-SCHED][TN]。Apple：「Once scheduled, a notification request remains active until its trigger condition is met, or you explicitly cancel it」[UN-SCHED]。
- **未确认，需实测：** 触发时刻机器仍在睡，横幅是当时就出现（很可能没人看）、还是等到唤醒。Apple 本地通知文档没写 macOS 睡眠。锁屏显不显示由 `lockScreenSetting` 管 [UN-SET]。Power Nap（`pmset powernap`）是睡眠中的部分后台活动 [PMSET]，没有文档说它会弹出 Notification Center 横幅。
- 睡眠期间发生的平台事件：Node 当时跑不了处理函数。要「睡醒后补一条」，得是进程还活着、自己排队，或在睡着之前就把 `UNNotificationRequest` 交给系统。osascript `display notification` 没有「交给系统、以后再出」的参数，只有立刻显示 [SDEF]。

## 仍需实测的清单

1. 本机 macOS 26 上，从 Terminal 里的 Node `execFile('osascript', …)` 发一条，设置里出现的应用名、是否弹权限框、点横幅会发生什么。
2. 同一条在 Focus 开着、alert 样式为 None、定时摘要开着时，osascript 退出码是否仍为 0。
3. Aqua LaunchAgent 跑平台 API 时，osascript 和 terminal-notifier 各自能否投递；Background LaunchAgent / SSH 会话里 osascript 是超时、报错还是静默成功。
4. 发行版 / Homebrew / node-notifier 自带的 `terminal-notifier.app`：第一次权限框、`-open http://127.0.0.1:…` 点击是否打开浏览器、把 bundle 放在项目 `node_modules` 而不是 `/Applications` 时点击 relaunch 是否还找得到。
5. 机器睡下去之后：即时 `osascript` / `notify()` 是否要等唤醒才执行；`-in 1m` 在睡眠跨越触发点时是睡中投递还是醒后才出现。
6. `node-notifier` 12.1.0 在仓库允许的 Node 22.18 上能不能装、要不要钉更高的 Node 或更老的 node-notifier。
7. Docker Desktop 旁的宿主机进程：确认 PoC 的 API/worker 确实跑在宿主机 Aqua 会话，而不是 Linux 容器里（容器里这两条路都不存在）。
