# 2026-05-10 装维知识库 + 场景清单扩展

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

`script.js` `initialDictionaries.sceneTypes` 从 4 类扩到 7 类：

```
基本保障 / 服务 / 随销 / 异常升级 + 装维流程 / 故障诊断 / 投诉预处理
```

服务端 `dictionaries.sceneTypes` 已通过 `import-state.mjs` 同步更新（version 40+）。

## 三、场景清单数据

把装维知识库内容沉淀为 27 条知识库场景 + 9 条原演练场景 = 共 36 条：

| ID 段 | 类型 | 数量 | 说明 |
| --- | --- | --- | --- |
| BZ-001 ~ 003 | 基本保障 | 3 | 原演练 |
| FW-001 ~ 003 | 服务 | 3 | 原演练 |
| SX-001/003 | 随销 | 2 | 原演练 |
| YC-001 | 异常升级 | 1 | 原演练 |
| KB-SX-001 ~ 013 | 随销（知识库） | 13 | 入户开口/四看/拒绝处理/FTTR 六场景/痛点制造/质差路由全流程/移动看家/电视会员/千兆路由/号卡/异议四步法/家庭画像/收尾 4 步 |
| KB-LC-001 ~ 005 | 装维流程（知识库） | 5 | 晨会/入户前/入户中/出户前/出户后 |
| KB-GZ-001 ~ 005 | 故障诊断（知识库） | 5 | 网页慢/游戏卡顿/视频卡顿/弱覆盖/频繁断网 |
| KB-TS-001 ~ 004 | 投诉预处理（知识库） | 4 | 基础命令/DNS与端口/路由抓包/拨测分析 |

数据导入文件：
- `server/kb-scenes.json`（13 条 KB-SX）
- `server/kb-scenes-v2.json`（14 条 KB-LC/GZ/TS + dictionaries 更新）
- `server/演练-scenes.json`（9 条原演练场景）

通过 `server/import-state.mjs` 合并到生产 API（http://47.102.216.22/sop/api）。

> 早期 5 条 `SCN-TEST-*` 测试链路场景已删除，因为 KB- 知识库场景 + 演练场景已完整覆盖所有类型。

## 四、场景 ID 命名规则

新增统一命名规则，在"场景清单"页面顶部加图例说明：

```
[KB-]<类型缩写>-<3位序号>
```

- `KB-` 前缀：知识库场景（培训/SOP）
- 无前缀：演练场景
- 类型缩写：
  - `BZ` 基本保障
  - `FW` 服务
  - `SX` 随销
  - `YC` 异常升级
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
node import-state.mjs 演练-scenes.json http://47.102.216.22/sop
```

最终生产状态：version 43，36 条场景，0 条悬空 schedule 引用。
