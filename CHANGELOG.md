# Changelog

按日期倒序记录前端 + 后端 + 数据的变更。每条改动应同步更新
[`HANDOFF.md`](./HANDOFF.md) 的"Recent changes"表和检查点信息。

---

## 2026-05-10 — 术语统一：演练 → 穿越

按用户要求把控制台里所有用户可见的"演练"统一改为"穿越"：

- 导航 + h2 + hero 文案：`演练日程` → `穿越日程`，`从演练到训练数据` → `从穿越到训练数据`，`苏州移动现场演练` → `苏州移动现场穿越`。
- 字典表：`演练中` → `穿越中`，标签 `演练结果` → `穿越结果`，`是否影响演练` → `是否影响穿越`。
- 表单字段：`是否影响5月6日演练` → `是否影响5月6日穿越`。
- README 增加术语脚注；脚本注释 + 当日总结菜单同步更新。
- 历史 CHANGELOG 条目里的"旧演练 ID"等历史叙述保持原文，避免改写历史。

如果生产 `state.json` 里有旧 `status="演练中"`、`results="演练通过"` 等数据，需要再做一次 `import-state.mjs` 全量替换或单独写迁移；本次未涉及。

## 2026-05-10 — 穿越日程同步 AICP-01.xlsx

按 `kb/AICP-01.xlsx` 的 9 行原始记录刷新 6 条日程：

- 牵头人修正：5/6 上午、5/7 下午改为「黄晓瑜」；5/8 下午改为「蔡俊」（之前误录朱江）。
- 穿越人员补全：5/7 上午增补「苏州铁通 周岗」；5/8 下午改为「相城区装维 钟队长 + 园区装维队员 邓师傅 + 好活科技 4 人」；其余行新增牵头单位前缀，便于一眼看出归属。
- 10 张「会议成果」图重新从 xlsx 提取（cellimages → media/image*.jpeg），按长边 1600px 重压到 ~400KB，覆盖 `console/assets/schedule/ID_*.jpg`。
- `defaultUsers` 增补 6 人：黄晓瑜、周岗、丁金辉、李明、钟队长、邓师傅。
- 同步快照：`server/schedule-aicp-01.json`，通过 `import-state.mjs` 推送到生产覆盖 `dailySchedules` 和 `users`。

```bash
cd console
SSHPASS='<password>' ./deploy.sh
cd server
node import-state.mjs schedule-aicp-01.json http://47.102.216.22/sop
```

## 2026-05-10 — 知识库文件维护

在"装维知识库 → 资料原文"中新增维护文件区：

- 统一展示内置资料和维护上传文件，不再只有上传文件可以进入预览面板。
- 内置 Word、Excel、PPT 使用 `assets/source/装维资料/extracted_text/` 中的抽取文本预览。
- 支持上传 `.pdf/.png/.jpg/.webp/.txt/.md/.csv/.doc/.docx/.xls/.xlsx/.ppt/.pptx`。
- 支持列表维护、删除、下载。
- 支持图片、PDF、TXT、Markdown、CSV 网页预览；Office 文件提供下载查看。
- 后端新增 `/api/kb-files` 系列接口，文件持久化到 `server/data/kb-files/`，部署不会覆盖。
- 上传安全沿用白名单策略：阻断 HTML/SVG/JS，下载和预览均强制规范 `Content-Type`、`nosniff` 和沙箱头。
- `server/smoke-test.mjs` 增加知识库文件上传、预览、下载、删除和 XSS 防护冒烟测试。

## 2026-05-10 — 装维知识库 + 场景清单扩展

本次改动把苏州移动装维资料系统化进了 SOP 控制台，并把"场景清单"扩展为覆盖全套装维 SOP 的演练入口。

## 一、装维知识库（新模块）

把原"装维脑图"导航项重命名为"装维知识库"，并把单页脑图替换为 8 个标签页：

| 标签页 | 内容来源 |
| --- | --- |
| 脑图速览 | 整体业务地图（保留原脑图） |
| 装维流程 | 晨会 / 预约 / 入户前 / 作业中 / 出户前 / 出户后 |
| 晨会脚本 | 工装、工具、四必讲、登梯登杆、登高五必做、六严禁、一级风险源、一看二想三拍四操作 |
| 故障诊断 | 5 类细分场景：网页加载慢、游戏卡顿、直播/视频卡顿、特定房间信号差、频繁断网 |
| 入户话术 | 17 张卡：开口 4 层切入 / FTTR 6 场景 / 异议 3 类 / 四看 4 维度 |
| 投诉预处理 | 12 个工具卡，含命令模板：ping/tracert/nslookup/dig/tcping/besttrace/wireshark/nmap/curl/F12/itdog/17ce |
| iPhone Wi-Fi | iPhone 接入 Wi-Fi 提示无网络的设置流程 |
| 资料原文 | 15 份 docx/pptx/xlsx/pdf/png 原文件下载入口 |

实现细节：
- HTML：`index.html` 中 `#mindmap` 视图替换为 `kb-tabs/kb-pane` 结构。
- 样式：`styles.css` 新增 `.kb-tab` / `.kb-pane` / `.kb-card` / `.kb-stage` / `.kb-fault` / `.kb-tool` 等装维知识库类。
- 脚本：`script.js` 新增 `initKbTabs()`，绑定 8 个标签页切换。

## 二、场景类型扩展

`script.js` `initialDictionaries.sceneTypes` 当前保留 4 类知识库场景：

```
随销 / 装维流程 / 故障诊断 / 投诉预处理
```

服务端 `dictionaries.sceneTypes` 已通过 `import-state.mjs` 同步更新（version 40+）。

## 三、场景清单数据

把装维知识库内容沉淀为 27 条知识库场景，并清理旧演练 ID，场景清单和下拉项只保留 `KB-*`：

| ID 段 | 类型 | 数量 | 说明 |
| --- | --- | --- | --- |
| KB-SX-001 ~ 013 | 随销（知识库） | 13 | 入户开口/四看/拒绝处理/FTTR 六场景/痛点制造/质差路由全流程/移动看家/电视会员/千兆路由/号卡/异议四步法/家庭画像/收尾 4 步 |
| KB-LC-001 ~ 005 | 装维流程（知识库） | 5 | 晨会/入户前/入户中/出户前/出户后 |
| KB-GZ-001 ~ 005 | 故障诊断（知识库） | 5 | 网页慢/游戏卡顿/视频卡顿/弱覆盖/频繁断网 |
| KB-TS-001 ~ 004 | 投诉预处理（知识库） | 4 | 基础命令/DNS与端口/路由抓包/拨测分析 |

数据导入文件：
- `server/kb-scenes.json`（13 条 KB-SX）
- `server/kb-scenes-v2.json`（14 条 KB-LC/GZ/TS + dictionaries 更新）

通过 `server/import-state.mjs` 合并到生产 API（http://47.102.216.22/sop/api）。

> 早期 `SCN-TEST-*` 和 `BZ/FW/SX/YC-*` 旧演练场景已清理，避免下拉项继续出现旧 ID。

## 四、场景 ID 命名规则

新增统一命名规则，在"场景清单"页面顶部加图例说明：

```
KB-<类型缩写>-<3位序号>
```

- `KB-` 前缀：所有维护场景统一前缀
- 类型缩写：
  - `SX` 随销
  - `LC` 装维流程
  - `GZ` 故障诊断
  - `TS` 投诉预处理

代码常量：`script.js` 顶部新增 `SCENE_TYPE_CODES` 映射，配套注释。
样式：`styles.css` 新增 `.naming-legend` 类。

## 五、生产部署

通过 `deploy.sh`（rsync + systemd）部署到 Aliyun（47.102.216.22:/var/www/html/sop/）。
访问入口：[http://47.102.216.22/sop/](http://47.102.216.22/sop/)

部署步骤：
```bash
cd console
SSHPASS='<password>' ./deploy.sh
cd server
node import-state.mjs kb-scenes.json http://47.102.216.22/sop
node import-state.mjs kb-scenes-v2.json http://47.102.216.22/sop
```

最终生产状态：27 条 `KB-*` 场景，旧演练 ID 不再出现在场景清单和下拉项。
