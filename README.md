# AICP 数据收集控制台

AICP SOP 穿越、录音关键词、问题需求与训练数据采集控制台。

## 功能

- 场景清单：新增、删除、修改、查询
- 演练日程：查询、状态维护
- 现场记录：新增、删除、修改、查询
- 录音关键词：新增、删除、修改、查询，录音文件统一为 `.mp3`
- 问题需求：新增、删除、修改、查询
- 字典表：维护场景类型、状态、轮次、采集设备、问题类型等下拉选项
- 数据导出：支持 `JSON` 和 `CSV`

## 本地运行

```bash
python3 -m http.server 8090
```

访问：

```text
http://127.0.0.1:8090/
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

