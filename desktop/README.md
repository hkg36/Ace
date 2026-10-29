# Crew Desktop

Crew 的 Electron 桌面客户端。它连接本机 Crew Gateway，提供对话、任务、技能、Wiki、浏览器控制、外援与系统管理界面。

> 当前为源码预览版。仓库不提供预编译安装包、代码签名、公证或自动更新服务。

## 快速开始

在仓库根目录执行：

```bash
uv venv .venv --python 3.13
source .venv/bin/activate       # Windows PowerShell: .venv\Scripts\Activate.ps1
uv pip install -e ".[dev,wiki]"

cd desktop
npm install
npm start
```

`npm start` 会构建 Desktop 并自动启动托管 Gateway，无需另开后端进程。它读取仓库根目录的
`config/config.yaml`；默认 `auth.mode: email`，首次打开会显示邮箱登录页。邮箱不需要验证码，
仅用于生成相互隔离的本机租户 Owner。

如果只进行日常开发、不测试邮箱登录流程，使用：

```bash
cd desktop
npm run dev
```

`npm run dev` 会传入 `--dev`，使用隔离的 `dev:dev` Owner 和开发数据目录，不显示邮箱登录页。
普通模式和开发模式都使用托管端口 `28180`；连接成功后，渲染层会记录实际地址。

首次打开后，在“设置 → 模型”中添加模型并将其设为默认。API Key 写入当前用户的本地环境文件，不会返回给渲染层。

## 主要能力

- **对话与会话**：流式回复、thinking、工具调用、停止与追加指令、附件、工作空间、会话归档和 Team 协作。
- **模型**：设置页负责模型 Profile 的新增、编辑、删除和默认模型切换；对话区可为当前会话单独选择模型。
- **任务**：定时任务的创建、筛选、启停和立即执行。
- **技能**：浏览内置、插件和用户 Skill，管理本地安装状态及可选的 Skill 自进化开关。
- **Wiki**：创建本地知识库、导入文件并通过独立 Wiki 会话问答。
- **浏览器与 Computer Use**：在工作区内查看和控制浏览器；所需 `cua-driver` 通过“设置 → MCP 服务”按需安装。
- **外援**：接入外部 Runtime、Agent 和 Team，并从对话输入区发起外援协作。
- **渠道与 MCP**：在设置页配置渠道账号、连接状态和 MCP Server。
- **系统信息**：Gateway 状态、运行日志、Token 用量和审计视图。

## 模型切换规则

- 设置页的“设为默认”会更新当前用户的默认模型，新会话在没有显式绑定时继承该模型。
- 对话区模型选择器只修改当前会话；已有其他会话不受影响。
- 任务运行期间切换会话模型时，新模型从下一条消息开始生效。
- 外部 Agent 是否支持切换模型，由对应 Runtime 的能力声明决定；Team 会话的成员模型由 Team 配置决定。

## 请求失败与重试

- 请求失败（包括首轮失败）时，错误旁显示“重试上次操作”；错误和按钮不会随过程区折叠。
- 重试复用原消息及附件，不重复添加用户气泡。当前会话正在运行时，不允许重复重试。
- 重新加载失败会话的历史后，也可重试最近失败的请求；仅有历史记录时，使用当前会话模型与发送模式。
- API Key 失效时，请先在“设置 → 模型”中修正配置再重试；重试不会自动修复凭据。

## Gateway 与身份

- `npm run dev` 使用隔离的托管 Gateway 和 `dev:dev` 开发 owner。
- `npm start` 使用普通托管 Gateway，并按 `config/config.yaml` 的 `auth.mode` 进入邮箱、免登录或远程验证码模式。
- 独立启动 `python -m crew.gateway.server` 时，Gateway 默认监听 `127.0.0.1:8000`。
- Ace 正式配置默认使用 `email` 身份：用户填写邮箱后生成隔离 owner，不校验邮箱所有权；`local` 仍可配置为本机免登录模式。启用 `auth.mode: remote` 后，Desktop 使用手机号验证码，并在主进程安全存储 Gateway 会话 Cookie。
- Browser 控制接口除登录会话外，还使用安装实例密钥派生的 Bearer Token。

## 代码结构

| 路径 | 职责 |
|------|------|
| `src/main/` | Electron 主进程、窗口生命周期、Gateway 管理、认证与 Browser Host |
| `src/shared/` | 主进程、预加载脚本、渲染层和测试共用的类型、常量与 IPC 校验 |
| `src/ui/` | 渲染层入口、Gateway 客户端、状态管理与页面功能 |
| `assets/index.html` | Desktop 页面结构 |
| `assets/styles/` | 主题、布局和组件样式 |
| `tests/unit/` | Vitest 单元与回归测试 |
| `tests/visual/` | Playwright 冷启动与视觉测试 |
| `scripts/check-security.mjs` | Electron/IPC/XSS 等静态安全门禁 |
| `electron-builder.yml` | Linux、Windows 和 macOS 的 Electron `dir` 构建配置 |

渲染层通过 `window.Crew` 的最小预加载桥访问主进程能力。`gateway:fetch` 仅允许本机 Gateway 的 `/api/` 路径；外部链接、文件选择和上传均在主进程执行白名单及大小校验。

## 开发与验证

界面图标使用本地 Font Awesome Free SVG sprite，不依赖 CDN 或在线字体。
语义 ID 在 `src/ui/components/icon.ts` 中定义；图形映射位于
`scripts/generate-icon-sprite.mjs`，修改后运行 `npm run icons:generate` 并提交
`assets/crew-ui-symbols.svg`。DOM 使用 `createIcon`，HTML 模板使用 `iconMarkup`。
图标许可和来源见仓库根目录的 `NOTICE`。

```bash
npm run dev          # 开发启动
npm run build        # 构建主进程与渲染层
npm run check        # typecheck + lint + unit tests + 安全/CSS 门禁

# 首次运行浏览器级视觉测试前安装 Chromium
npx playwright install chromium
npm run test:visual
```

提交 Desktop 改动前至少运行 `npm run check`。涉及布局、引导或 Browser 面板时，再运行对应的 Playwright 视觉测试。

### Electron / 内置浏览器升级验证

当前 Electron 锁定为 `45.1.0`；`playwright-core` 与 `@playwright/test` 必须同时锁定为
`1.64.1`，并同步 npm、pnpm 锁文件。内置浏览器直接使用 Electron 的 Chromium，
不需要安装额外的 Playwright Chromium；上面的安装命令仅用于独立视觉测试。

```bash
npm run check:playwright-boundary
npm run typecheck
npm run build
npm run test:pw-contract
```

真实契约使用隐藏 Electron 窗口验证点击、快照、跨域框架、弹窗、下载、上传、录制回放、
AI/人工接管切换及系统剪贴板图片读回。运行器隔离临时数据目录，并在 Electron 退出后
清理 Windows 上仍被 Session 锁定的 Profile 文件。测试会短暂使用系统剪贴板，结束后恢复内容。

Windows 本地升级检查仍发现隐藏窗口的 `Page.captureScreenshot` 请求不返回，
导致 Playwright 页面截图和元素截图超时；关闭 GPU 或窗口遮挡计算未解决。
视觉操作的 `vision_screenshot` 和浏览器面板截图改用原生
`webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })`，
不显示隐藏窗口，并保留 PNG 物理像素尺寸与视觉 epoch 的校验。空图或原生捕获错误明确上报，
不回退到可能挂起的 CDP 截图。

原生 API 捕获当前视口，不等同于 Playwright 的整页、元素及 CSS 缩放截图。
用户导出的 `screenshot` 和公开的 Playwright `Page/Locator.screenshot()` 仍保留原实现，
对应契约尚未通过，不能仅凭原生视口截图成功就认定全部截图兼容。
其他平台与打包产物仍需分别验证。

Electron 45 的剪贴板使用异步 `ClipboardItem` API，写入完成前不得向 IPC 调用方返回成功。
另需注意账号 Cookie 和 SSH 密码目前仍使用 `safeStorage` 同步接口：45 中可用但已弃用，
官方计划在 46 移除，升级 46 前需要迁移至异步接口。

## 本地预打包

以下命令只生成 Electron 裸目录，不生成面向最终用户的正式安装器：

```bash
npm run dist:linux
npm run dist:win
npm run dist:mac
```

应在与目标一致的操作系统上执行。产物位于 `desktop/release/`；正式分发前仍需配置代码签名、公证、安装权限与更新来源。

包含 Gateway 和运行时的完整安装器构建方式，见根目录 [README](../README.md#构建桌面发行包可选)。
