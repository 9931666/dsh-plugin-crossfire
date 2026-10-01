# 针锋 Crossfire

**把一个已经定稿的成果摆上台，让红队从指定维度分头攻击，由你逐条认定或驳回。**

Crossfire 是 DeepSeek Harness 的一个插件，只做一件事：**对抗式评审**。它不产出方案、不改代码、不自动修复 —— 它是验收器，不是执行器。

## 它和别的多智能体插件有什么不同

| | 协作型团队（如 AgentTeams） | 圆桌会议 | **针锋 Crossfire** |
| --- | --- | --- | --- |
| 目标 | 把活干完 | 开一场多角色会议 | **判定一份成果站不站得住** |
| 机器做什么 | 分工、执行、自动修复 | 统筹、转述、聚合 | **只挑错** |
| 谁下结论 | 流程门禁 | 主持人汇总 | **你，逐条** |
| 界面 | 成员树 / 任务 DAG | 拓扑图 + 面板 | **一张卡，四个状态** |

四条边界（越界即破坏了它存在的意义）：

1. **表态永远由人做。** 缺陷的认定 / 驳回只能在卡片上由你操作；插件**没有**、也**不该有**"代表认定缺陷"的工具。
2. **不产出方案、不改代码、不自动修复。**
3. **红队专家只读。** 它们的工具是白名单：`read` / `read_image` / `glob` / `grep` + 一个 `crossfire_report`。能取证，不能动手。
4. **你的历史表态只用于去重与复审递进**，绝不会作为"用户画像"喂给红队 —— 否则模型会预判你的偏好而干脆不提某类问题，与"反方攻击"的初衷正好相反。

## 安装

```sh
dsh plugin --profile web add @huanlin/dsh-plugin-crossfire
```

安装后**重启 Harness 进程**并刷新浏览器（host 侧改动不热重载）。

环境要求：DeepSeek Harness `0.2.0-rc.2+`、Node `>= 22`（开发时为 `24.x`）。

## 用法

在对话里说一句「用针锋评审一下这个方案」，或者在卡片上点按钮 —— 两条路驱动的是**同一套状态机**。

```
draft ──送红队上场──▶ attacking ──收集观点──▶ judging ──定稿──▶ settled
                                                ▲                │
                                                └──── 开复审 ─────┘
                                                   （只核对旧账）
```

### 工具面（`crossfire_*`）

| 工具 | 作用 |
| --- | --- |
| `crossfire_open` | 把待验证对象摆上台（标题 + 正文 + 维度 + 强度）。状态 `draft` |
| `crossfire_stance` | 写入用户的立场与理由；没有就**从对话提炼**（`distilled=true`），但绝不虚构 |
| `crossfire_attack` | 按维度拉起只读红队专家。状态 `attacking` |
| `crossfire_collect` | 把专家发言拆成逐条可裁决的缺陷。状态 `judging` |
| `crossfire_finish` | 定稿，固化 known-flaws 清单并写入历史。状态 `settled` |
| `crossfire_recheck` | 复审：只核对上一轮已认定的缺陷是否修复 |
| `crossfire_export` | 导出 Markdown 交付物 |
| `crossfire_report` | **专家侧**：红队提交发言的唯一通道 |

### 卡片

在对话轨迹里占一张卡（`tool.call.toolview`，key = `crossfire_open`），每张缺陷一张子卡，可内联**认定 / 驳回（必填理由）/ 待定**，三态可互切。卡片每秒轮询快照，因此状态机一变它立刻跟着变。

顶部影响条显示 `认定 / 驳回 / 待定` 与"打穿立场"的条数。

## 数据落在哪

```
<工作区>/.crossfire/crossfire/<reviewId>/
  review.json        评审记录（议题、立场、缺陷三态、历史轮次）
  transcript.jsonl   红队发言（append-only）
  user-actions.jsonl 用户行为
  export.md          导出物
```

命名空间与圆桌会议的 `.roundtable` **完全隔离**：两个插件零代码耦合，互不读写对方的状态。

刻意**没有**的东西：拓扑图、有向边、聚合网关、知识库中继、skill 中继、代理思考。

## 两个"修好了的真实缺陷"

1. **维度标签**：圆桌的历史数据里 `dimension` 实值是 `维度②` / `其他` / 空串（圆圈数字被当成了维度名）。Crossfire 的规则是**落库维度必须 ∈ 本次采用维度**，越界者归一化并留下 `dimensionFallback` 标记。
2. **过程叙述污染裁决面**：`[当前状态] 已收到主持人任务…` 这类发言曾被当成缺陷收进列表。Crossfire 在收集阶段拦掉 `auto-capture` 与行首进度标记，但**不误杀**真缺陷（"密钥硬编码在源码里"这类短句有专门的测试守护）。

## 开发

### 从源码跑起来（克隆后必读）

`.gitignore` 排除了 `node_modules/` 与 `lib/`，所以**克隆下来是一个没有构建产物的源码树** ——
`package.json` 的 `main` 指向 `./lib/index.js`，不构建就装不上：

```sh
pnpm install                 # 或 npm install
pnpm run build               # typecheck×2 → tsdown 双产物 → 声明生成
```

> 本仓库的 `node_modules/` 在作者机器上是指向另一个本地包的 junction（提权创建），因此
> 它**绝不入库**；克隆后请自行安装依赖。

### 四条门禁

```sh
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit        # host 类型
node ./node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit # client 类型
node --test --test-isolation=none "test/*.test.mjs"                     # 单测（零新依赖）
node ./node_modules/.bin/tsdown.cmd -c tsdown.config.ts                 # 构建双产物
```

`--test-isolation=none` 不是可选项：受限环境下 `node --test` 默认为每个测试文件 spawn 子进程并捕获其输出，会直接 `EPERM`。

### 装好之后的运行时验收

需要连真实运行中的 Harness（**只能在浏览器里跑**）：

1. 打开 DSH Web GUI，按 F12 打开控制台
2. 把 `test/browser-acceptance.js` 整段粘贴进去回车
3. 看 `PASS / FAIL / SKIPPED`

为什么必须在浏览器：插件自建的两条 Web 路由走宿主的
`connection.requestRejection` 栅栏（Host/Origin + 浏览器认证）。裸 Node 进程没有那个
认证上下文，会被 `401 connection trust check failed` 拦下 —— 这是**栅栏在正常工作**，
不是缺陷。

## License

MIT
