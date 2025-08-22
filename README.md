### Android Logcat (Cursor)

最小可用的安卓 Logcat 插件，复用现有 `cli_logcat.sh`，在 Panel 中展示实时日志。

#### 使用
- 打开本工程后，执行：
  - `npm install`
  - `npm run compile`
- 按 F5 以 “Run Extension” 调试一个新窗口
- 在底部 Panel 中找到 “Android Logcat”，选择设备后点击 “开始”。

#### 配置
- 设置项：`cursorAndroidLogcat.scriptPath` 指向你的脚本，默认：
  - `/Users/edward/PythonProjects/AutoWorkFLow/logcat_android/cli_logcat.sh`

#### 注意
- 输出使用 `--no-color` 去色显示；如需彩色可后续引入 ANSI 渲染。

