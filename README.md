[TOC]

### 插件安装方式
1. 打开Cursor->顶部导航栏View->Command Palette。
2. 输入Extensions: Install from VSIX...。
![](./doc/image2.png)
3. 在项目工程./vsix_directory目录选择需要安装的vsix文件。
4. 安装完成后，重启Cursor。
5. 打开右上角Toggle Panel->然后选择android logcat。


### android-logcat（Cursor插件）
为 Cursor打造的一个轻量且实用的 Android Logcat 面板插件。在底部 Toggle Panel 中提供 “android logcat” 标签页，支持设备选择、实时过滤、大小写匹配、软换行、暂停/恢复、清空日志、按级别着色，以及将日志保存到文件。
![](./doc/image1.png)

#### 架构概览

```mermaid
flowchart TB
  subgraph Cursor Extension
    V[Webview View: android-logcat-view]
    E[extension.ts]
    H[media/view.html]
    C[media/view.css]
    J[media/view.js]
  end

  subgraph Shell Script
    S[scripts/logcat_android/cli_logcat.sh]
  end

  V <-- postMessage/receiveMessage --> E
  V -.-> H
  V -.-> C
  V -.-> J
  E -->|spawn + env DISABLE_SCRIPT=1| S
  S -->|stdout/stderr| E -->|append| V
```

- Webview 层（`view.html` + `view.css` + `view.js`）渲染 UI，所有交互通过 `postMessage` 与 `extension.ts` 通信。
- 扩展后端（`extension.ts`）使用 `child_process.spawn` 调用 `cli_logcat.sh`，通过 `--no-color` 输出加上 `DISABLE_SCRIPT=1` 环境变量，避免在无 TTY 环境报错；并对日志流做批量聚合与节流后回传到 Webview。
- 脚本层：内置 `scripts/logcat_android/cli_logcat.sh`，默认可直接使用。

#### 布局与主要能力
- 第一行（顶栏）：设备下拉框、保存到文件、过滤输入框、Cc（Match case）开关。输入框实时过滤当前视图。
- 第二行（状态）：展示当前跟随/暂停等状态提示。
- 第三行（主体）：
  - 左侧 50px 侧栏：按钮纵向排列（暂停/恢复、清空）、Sp（Soft-wrap）复选框。
  - 右侧日志视图：可滚动、支持软换行、按级别着色与快速过滤。

其它能力：
- 设备获取：`adb devices -l` 自动列出可选设备。
- 暂停/恢复：暂停仅停止向 UI 追加，进程不退出；恢复会一次性冲刷暂停期间缓存。
- 清空：仅清空 UI 与缓冲，不中断采集进程。
- 保存到文件：启用后传入 `-f` 由脚本侧保存。
- 跟随滚动：停留底部时自动跟随；离开底部时合并缓冲并提示。
- 颜色高亮：按行检测级别 V/D/I/W/E/F/S，应用对应颜色，提升可读性。
- 性能优化：扩展端 ~30fps/64KB 批量聚合后发送；隐藏时缓冲、显示时一次性冲刷；前端最大文本约 2MB，超限从头裁剪；requestAnimationFrame 批量渲染。
- 状态持久化：过滤词、Cc、Sp 状态使用 Webview state 持久化，切换 Tab 后仍保留。

快捷操作：
- 双击日志区域 / 点击状态栏 / 键盘 End：快速恢复到底部并继续跟随。

#### 本地开发与编译
1) 安装依赖与构建
```bash
npm install
npm run compile
```
2) 调试运行
- 在 Cursor 中 F5 选择 “Run Extension” 启动新的开发宿主窗口。
- 打开底部面板，切换到 “android logcat”。

3) 必备依赖
- 需要安装 adb：
  - macOS: `brew install android-platform-tools`
  - Windows: 安装 Android Platform-Tools，并把 `adb` 加入 PATH（脚本为 bash）。

#### 配置
- `cursorAndroidLogcat.scriptPath`：可覆盖默认脚本路径。
  - 留空：指向扩展内置脚本 `scripts/logcat_android/cli_logcat.sh`。
- `cursorAndroidLogcat.debug`：启用后输出调试日志到 `Android Logcat (Cursor)` 输出通道。

#### 打包 VSIX
1) 生成 VSIX
```bash
# 项目根目录
npm run compile
npx @vscode/vsce package
# 生成：cursor-android-logcat-x.y.z.vsix
```
2) 安装 VSIX
- Cursor 命令面板（Cmd+Shift+P）→ Extensions: Install from VSIX… → 选择 VSIX。
- 或命令行（启用 `cursor` 命令后）：
```bash
cursor --install-extension /path/to/cursor-android-logcat-x.y.z.vsix
```

已适配 Cursor 1.99.x：`engines.vscode` 与 `@types/vscode` 均匹配该版本。

#### 项目结构（关键文件）
```
cursor-android-logcat/
  ├─ src/extension.ts           # 后端：注册视图、设备获取、脚本启动、流式回传
  ├─ src/services/              # 业务服务（单一职责，可测试）
  │   ├─ DeviceService.ts       # 设备跟踪、offline 回填、列表推送
  │   ├─ StreamService.ts       # 进程与日志流管理、历史拉取
  │   └─ ImportService.ts       # 导入模式状态与文件读取
  ├─ src/utils/
  │   └─ path.ts                # 路径与文件名工具
  ├─ media/
  │   ├─ view.html              # Webview 模板（占位符注入 CSP、nonce、样式与脚本）
  │   ├─ view.css               # UI 样式（固定工具行，日志区域自适应）
  │   └─ view.js                # 前端交互（postMessage、设备刷新、启停）
  ├─ scripts/logcat_android/
  │   └─ cli_logcat.sh          # 内置 logcat 脚本（支持 -s/-p/-t/-l/-b 等）
  ├─ package.json               # 插件清单、命令与视图、配置项、依赖
  ├─ tsconfig.json
  ├─ .gitignore                 # 过滤 node_modules/out/logs 等
  └─ .vscodeignore              # VSIX 体积优化
```

#### 兼容性与脚本增强
- `DISABLE_SCRIPT=1`：在无 TTY 的管道环境禁用 `script` 包装，避免 `tcgetattr/ioctl` 错误。
- `--no-color`：脚本输出去色，颜色在前端按级别渲染，避免 ANSI 码导致的对齐问题。
- 固定 `cwd`：启动脚本时将工作目录设为扩展目录，确保 `logs/` 可写。
- 终端复位：脚本启动/退出时复位终端（`stty sane`/`tput sgr0`），避免异常退出后终端错乱；stdout 非 TTY 时强制关闭颜色，保证重定向/管道输出可读。

#### 后续可做
- 更丰富的语法过滤（AND/OR、`tag:xxx`、`pkg:xxx` 等表达式）与高亮。


### 待办
1. 软换行-虚拟化窗口（解决上下快速滑动日志输出窗口短暂“黑屏”的问题）---已完成
2. 导出当前视图、复制全部、正则过滤等增强功能。---已完成
3. 列对齐与字段高亮（时间、PID/TID、TAG 列的定宽布局）。---已完成