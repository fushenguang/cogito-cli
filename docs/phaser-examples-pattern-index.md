# Phaser 示例模式索引（labs.phaser.io 资源工程）

> **用途**：模板固定页面（Start/GameOver/设置页）与玩法骨架开发时，**先查本索引、再读对应示例源码改造**，禁止无出处从零实现。每次参考改造必须在提交信息或代码注释里留下示例路径。
>
> **来源仓**（2026-09-01 clone 到 `~/Workspace/phaser-refs/`，不进任何 git 仓）：
>
> | 本地目录 | 来源 | 定位 |
> |---|---|---|
> | `examples/` | github.com/phaserjs/examples | labs.phaser.io 官方镜像，2000+ 示例按 `public/src/<分类>/` 组织 |
> | `phaser-by-example/` | github.com/phaserjs/phaser-by-example | 官方书 9 个完整游戏源码（JS + Vite） |
> | `phaserdeno/` | github.com/halfmonty/phaserdeno | 上者的 **TypeScript + Phaser v4** 转换版；**v4 兼容性以它优先** |
>
> 🔴 **资产许可**：examples 仓源码 MIT，但**资产不可商用**（老街机来源）。只取代码模式，游戏素材一律走平台 CC0 管线（`game-assets.json` 声明）。
>
> **v4 兼容标注口径**：`[v4✓]` = phaserdeno 已转换或 labs 站点 v4 索引（`examples/public/phaser4-index.html`）在线可跑；`[v3→v4 自查]` = v3 时代写法，用时对照 phaserdeno 同型代码自查。

## 1 · 开始页 / 结束页 / 设置页（深析 ✅ 读过源码）

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `phaserdeno/games/mars/scenes/splash.ts` | 官方书《Mars》标题页：BitmapText 逐字入场 + dropShadow + "SPACE start" alpha 呼吸提示 + `keydown-SPACE` 进 transition 场景 | [v4✓] |
| `phaserdeno/games/mars/scenes/outro.ts` | 通关页：标题淡入 + `keydown-SPACE/ENTER` 双键回 splash + `sound.stopAll()` | [v4✓] |
| `phaserdeno/games/runner/scenes/gameover.ts` | 失败页：`registry.get('score')` 读分 + "GAME OVER" 居中 + **键盘与 `input.on('pointerdown')` 双通道重启** + `scene.start('game')` | [v4✓] |
| `examples/public/src/games/my first game/scenes/MainMenu.js` | 主菜单极简式：背景图 + 居中 Text + `input.once('pointerdown')` 整屏点击进入 Game | [v4✓] |
| `examples/public/src/games/my first game/scenes/GameOver.js` | 失败→回主菜单：红底 + 半透明背景图 + `input.once('pointerdown') => scene.start('MainMenu')`——**「结束页回标题页」的官方范式** | [v4✓] |
| `phaser-by-example/mars/src/scenes/*.js` | 上书 JS 原版（与 phaserdeno 同构对照） | [v3→v4 自查] |

**深析要点（我们的采用方式）**：
- 官方结束页有两条回程：`scene.start('game')`（重试）与 `scene.start('MainMenu')`（回标题）——模板 GameOver 页的双按钮（重开 / 回标题）即此模式。
- 双输入通道（键盘 R + 指针点击）是官方 runner/gameover 的既有形态，保留。
- 分数跨场景用 `registry`（runner/gameover 与我们 UiScene 的 `changedata-score` 同型）。

## 2 · 文字渲染（深析 ✅）

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/game objects/text/basic text.js` | 最小 Text 创建 | [v4✓] |
| `examples/public/src/game objects/text/shadow stroke styles.js` | 描边/阴影保证浅色背景可读性 | [v4✓] |
| `examples/public/src/game objects/bitmaptext/static/` | BitmapText 预渲染字集（无 Canvas 2D 纹理上传链路） | [v4✓] |
| `phaserdeno/games/mars/scenes/splash.ts` | `bitmapText(...).setTint().setDropShadow()` v4 用法 | [v4✓] |
| `examples/public/src/game objects/dom element/` | Phaser DOMElement GameObject（需 config `dom.createContainer`）——模板未采用，固定页直接用原生 DOM overlay（见 `src/screen-dom.ts` 头注） | [v4✓] |

**深析要点（2026-09-01 实测，本仓 `docs/` 配套结论）**：
- 本机 chrome-headless-shell（Playwright 1234 / macOS arm64）实测：Phaser 4.2.1 Text **拉丁与 CJK 都正常出像素**（区域众数色法 + 正负对照自校准）。「Phaser Text 无头必不渲染」的旧说法**无据**。
- 但 Phaser Text 依赖 Canvas2D→WebGL 纹理上传整条链路 + 运行环境的字体覆盖；小小财迷 M1 的文字失效在其**交付环境**（guest VM）从未被诊断。**固定页关键文案走 DOM overlay**（浏览器主文本管线）+ postbuild 像素断言在真实交付环境每次构建重证——这是环境无关的结构性保证（issue #11 设计点）。
- CJK 排版字体栈用 `index.html` 既有的 `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`；**不随包附带字体文件**（模板 AGENTS.md 规则 4）。

## 3 · 按钮交互（深析 ✅）

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/game objects/text/simple text button.js` | Text+setInteractive 的最小按钮 | [v4✓] |
| `examples/public/src/input/mouse/` | 指针事件族（down/up/over/out） | [v4✓] |
| `examples/public/src/input/zones/` | 无纹理命中区（按钮热区） | [v4✓] |
| `examples/public/src/input/dom events/` | DOM 级事件接入（DOM overlay 按钮的参照） | [v4✓] |

## 4 · 场景切换（深析 ✅）

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/scenes/changing scene.js`（及 es6 版） | `scene.start(key)` 基本式 | [v4✓] |
| `examples/public/src/scenes/passing data to a scene.js` | `scene.start(key, data)` 带参——GameOver 收 score 即此 | [v4✓] |
| `examples/public/src/scenes/launch parallel scene.js`、`parallel scenes.js` | `scene.launch()` 平行 HUD 层（模板 UiScene 同型） | [v4✓] |
| `examples/public/src/scenes/pause and resume.js` | 暂停/恢复（设置页暂停玩法用） | [v4✓] |
| `examples/public/src/scenes/registry data exchange.js` | registry 跨场景通信 | [v4✓] |
| `examples/public/src/games/my first game/scenes/Game.js`（`initGameUi`） | `scene.launch('GameUi')` + `scene.get('GameUi')` 直接调方法 | [v4✓] |

## 5 · HUD

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/games/my first game/scenes/GameUi.js` | 平行 UI 场景持有分数文本，玩法场景跨场景调 `updateScore` | [v4✓] |
| `examples/public/src/scenes/parallel scenes.js` | 平行场景渲染顺序 | [v4✓] |
| 模板 `src/scenes/UiScene.ts` | 已内建：HUD 带 + `setScrollFactor(0)` + registry 事件驱动（仓内自有范式） | — |

## 6 · 平台跳跃（深析 ✅ 教学关几何直接参照）

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/games/my first game/scenes/Game.js` | 平台组 + collider、收集 overlap、危险 overlap、**Exit 终点 overlap**、镜头跟随、世界边界 | [v4✓] |
| `examples/public/src/games/my first game/gameObjects/Player.js` | **jumpVelocity=-520 / moveVelocity=200 / `body.touching.down` 才起跳 / setCollideWorldBounds** | [v4✓] |
| `examples/public/src/games/my first game/gameObjects/Platform.js` | 静态平台：`physics.add.existing(this, true)` + `addDynamicTexture().stamp()` 拼贴纹理 | [v4✓] |
| `examples/public/src/games/my first game/gameObjects/Exit.js` | 终点门 = 静态物理精灵，玩家 overlap 触发过关 | [v4✓] |
| `examples/public/src/games/my first game/game.js` | 游戏级配置：**gravity y=1000**（与 -520 跳速配套） | [v4✓] |
| `phaserdeno/games/mars/main.ts` + `gameobjects/player.ts` | v4 同型（gravity y=300 一档）；v4 物理配置写法自查基准 | [v4✓] |
| `examples/public/src/physics/`（arcade 族） | 碰撞/重叠/静态体全家桶，按目录检索 | [v4✓] |

**深析要点（教学关采用）**：重力/跳速/移速取官方教程配伍（1000/-520/200，教学关保守用 900/-480 一档即可），全部进 `game-data.json` 的 `rules`（规则即数据，AGENTS.md 规则 9）；平台用静态体，终点用静态精灵+overlap（Exit 模式），几何全部数据驱动。

## 7 · 计时 / 收集 / 危险物

| 示例路径 | 模式一句话 | v4 |
|---|---|---|
| `examples/public/src/games/my first game/scenes/Game.js`（collectStar / hitBomb） | 收集=overlap+销毁+加分；危险=overlap+`physics.pause()`+tint 标记 | [v4✓] |
| `examples/public/src/games/my first game/gameObjects/Star.js`、`Bomb.js` | 收集物弹跳（bounce）/危险物随机下落生成 | [v4✓] |
| `examples/public/src/time/` | 计时器族（timer event / countdown），按目录检索 | [v4✓] |

## 8 · 其余主题速查（按目录归类，未逐个深析）

- 动画：`game objects/sprites`、`animation/`
- 镜头：`camera/`（跟随、边界、震动）
- 缩放布局：`scalemanager/`
- 音频：`audio/`（含 autoplay/手势启动相关）
- 粒子：`game objects/particle emitter`
- 瓦片地图：`tilemap/`、`tilemaps/`（后续关卡工程化时再深析）
- 完整小游戏（结构参考）：`games/` 下 breakout、snake、stacker、"firstgame"（老版教程）等 15 个
