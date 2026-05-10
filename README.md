# AICP 数据收集控制台

AICP SOP 穿越、录音关键词、问题需求与训练数据采集控制台 + 苏州移动装维 SOP 知识库。

> **新接手这个仓库（含 codex）请先看 [`HANDOFF.md`](./HANDOFF.md)**：包含
> 架构概览、最近的安全修复、并发测试、部署流程和已知坑，以及 2026-05-10
> 装维知识库改造、场景类型扩展、ID 命名规则。后端细节在
> [`server/README.md`](./server/README.md)，最近一批改动详见
> [`CHANGELOG-2026-05-10.md`](./CHANGELOG-2026-05-10.md)。

## 功能

- **场景清单**：新增、删除、修改、查询。ID 规则 `[KB-]<2字母类型>-<3位序号>`，
  类型缩写 `BZ` 基本保障 / `FW` 服务 / `SX` 随销 / `YC` 异常升级 /
  `LC` 装维流程 / `GZ` 故障诊断 / `TS` 投诉预处理（详见 HANDOFF.md）。
- **演练日程**：按日期查询、状态维护，支持连续多天演练。
- **装维知识库**（左导航"装维知识库"）：8 个标签页，覆盖装维流程、晨会脚本、
  故障诊断、入户话术、投诉预处理工具链、iPhone Wi-Fi 设置、资料原文下载。
  原始资料目录在仓库外的 `../kb/苏州移动装维资料/`，可下载副本在
  `assets/source/装维资料/`。
- **现场记录 / 录音关键词 / 问题需求**：新增、删除、修改、查询。
- **本地录音**：支持上传 `.mp3`，网页内播放和下载。
- **字典表**：维护场景类型、状态、轮次、采集设备、问题类型等下拉选项。
- **当日总结**：按日期提交每日复盘摘要。
- **数据导出**：支持 `JSON` 和 `CSV`。
- **数据导入**：`server/import-state.mjs <file.json> [base-url]`，按 id 合并到
  服务端 state（详见 HANDOFF.md → 数据导入脚本）。

## 本地运行

控制台已经迁移到 Node 后端，前端的状态保存和音视频上传都依赖
`server/server.js`，纯静态预览（`python3 -m http.server`）只能看 UI 不能保存数据。

```bash
cd server
npm install
PORT=3091 node server.js
# 打开 http://127.0.0.1:3091/
```

跑测试（在 server 启动着的状态下，从另一个终端）：

```bash
cd server
BASE=http://127.0.0.1:3091 node smoke-test.mjs                          # 功能 + 安全冒烟
BASE=http://127.0.0.1:3091 CLIENTS=8 PER_CLIENT=3 node concurrency-test.mjs   # 并发写入
BASE=http://127.0.0.1:3091 CLIENTS=4 node upload-concurrency-test.mjs   # 并发上传
```

## 阿里云部署

目标地址：

```text
http://47.102.216.22/sop/
```

推荐将仓库内容部署到服务器目录：

```text
/var/www/html/sop/
```

Nginx 可使用如下 location：

```nginx
location /sop/ {
    alias /var/www/html/sop/;
    index index.html;
    try_files $uri $uri/ /sop/index.html;
}
```

本地修改后直接部署：

```bash
cd /Users/zhujmac/AICP/SOP/console
SSHPASS='服务器密码' ./deploy.sh
```

脚本默认使用 SSH 端口 `50022`，默认部署目录 `/var/www/html/sop/`。
部署完成后 `aicp-sop.service` 会自动重启；想看日志：
`ssh -p 50022 root@47.102.216.22 'journalctl -u aicp-sop -f'`。

> 危险操作：`POST /api/reset` 会清空所有数据。生产已经设了
> `ADMIN_TOKEN`，必须显式传 `-H "X-Admin-Token: <token>"` 才能调用。
> 见 `HANDOFF.md → Operational notes`。
