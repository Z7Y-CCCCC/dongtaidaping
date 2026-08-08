# 生产部署就绪与 PLC 故障演练报告

日期：2026-08-08
范围：多协议 PLC 采集、断联/恢复、数据库断电恢复、MySQL/SQLite 灾备、日志治理、进程自愈、HTTP 安全边界。
不在本轮范围：电视投屏兼容性与现场电视验收（由用户回家后实测）。

## 结论

本轮覆盖的自动化检查全部通过。系统已具备以下生产基础能力：

- 西门子 S7、Modbus TCP、OPC UA 均接入统一只读采集、坏质量、离线判定和自动重连流程。
- SQLite 断电 WAL 恢复、完整性检查、损坏文件隔离、自动恢复与恢复前回滚。
- MySQL 一致性压缩备份、完整校验、手工恢复、失败回滚和整站 ZIP 恢复。
- 日志按大小切卷、gzip、按天/数量/总容量清理。
- 后端异常退出或健康探测连续失败时，桌面壳有限次数自动拉起。
- Unity 父进程退出后，内嵌后台宿主会自动退出，不再残留 WebView2/AdminHost 进程。
- 后端默认只监听回环；即使误绑定到所有网卡，非本机修改请求仍默认拒绝。

正式上线仍需完成现场 PLC 点表逐点核对、真实网络交换机断链、BIOS 来电开机、Windows 自动登录、外部备份介质和投屏电视验收。

## PLC 协议支持与验证

| 协议 | 默认端口 | 地址示例 | 自动化验证 |
| --- | ---: | --- | --- |
| 西门子 S7 | 102 | `DB1.DBW0`、`DB1.DBX6.0` | 外部 Snap7 仿真器持续读取、断联、离线和恢复回归 |
| Modbus TCP | 502 | `HR40001`、`IR30001`、`C00001` | 本地 Modbus TCP Server 实际连接和 WORD/REAL/BOOL/输入寄存器读取；覆盖字节序和字序 |
| OPC UA | 4840 | `ns=2;s=Channel1.Device1.Tag1` | 客户端 Endpoint、安全模式/策略、身份、会话读取、状态码和失败清理流程测试 |

三种协议在后台共用设备级超时、重连间隔、最大重试次数和点位采集周期。系统当前只执行读取，不提供 PLC 写入接口。旧数据库启动时会自动增加 `devices.plc_options` 字段；OPC UA 密码保存后通过设备和公共配置接口只返回掩码。OPC UA 自动化使用可控客户端验证流程，正式上线仍必须连接客户现场真实 OPC UA Server，核对 Endpoint、NodeId、账号权限和证书信任链。

## PLC 仿真结果

仿真器：`C:\Users\27323\OneDrive\Desktop\PLC仿真调试器\snap7_engine.py`
协议：Snap7 S7 ISO-on-TCP
点位：`WORD / BOOL / REAL`，采集周期 `250 / 500 / 1000 ms`

最近一次完整回归：

| 项目 | 结果 |
| --- | ---: |
| 采集延迟 p50 | 143 ms |
| 采集延迟 p95 | 237 ms |
| 最大帧间隔 | 267 ms |
| PLC 断开后坏质量 | 111 ms |
| PLC 断开后判离线 | 4152 ms |
| PLC 恢复后首个好帧 | 1027 ms |
| PLC 恢复后在线状态 | 1368 ms |
| 恢复后连续读数 | 8/8 成功 |

隔离测试使用临时 SQLite 数据库和独立端口，没有修改现场 MySQL 配置。测试结果文件位于 `output/plc-integration-*`。

## 数据与灾备结果

### SQLite

- 强制终止后端前最后一次已确认写入在重启后仍存在。
- `journal_mode=WAL`，`quick_check=ok`。
- 人为破坏数据库头后，程序从最新有效备份恢复，并把损坏文件移入 `recovery`。
- 手工恢复前自动创建 `before-restore` 回滚备份。

### MySQL

- 使用与服务器兼容的 `mysqldump/mysql` 工具，密码通过短生命周期配置文件传递。
- 备份格式为 `.sql.gz`，创建后完整解压并检查结构/数据标记。
- 独立临时数据库中完成“写入 → 备份 → 修改 → 恢复 → 核对原值”。
- 恢复前自动创建压缩回滚备份；恢复失败会尝试自动回滚。
- 整站 ZIP 中包含 MySQL dump、上传模型、语音文件、大小和 SHA-256 清单。
- 损坏 ZIP、清单外文件、路径穿越、超数量、超单文件或超解压体积均拒绝。

### 异地备份

后台可配置每 1～168 小时自动生成整站 ZIP，并填写 U 盘/移动硬盘/NAS 目录。复制采用临时文件、SHA-256 比对和原子改名。未配置外部目录时，状态会明确提示本机副本不能防电脑丢失。

本轮已对临时外置目录完成真实复制演练：目标目录只出现校验完成后的正式 ZIP，不会把复制一半的文件误当成可恢复备份；源文件与外置副本 SHA-256 一致。

## 日志与磁盘治理

- 活动日志：单文件默认 10 MB。
- 归档：gzip level 6。
- 保留：默认 30 天、最多 60 个归档。
- 总容量：默认最多 250 MB，超限从最旧归档开始删除，并至少保留最新一个。
- 清理周期：软件启动时和每 6 小时。
- MySQL/SQLite 数据库备份默认保留 10 份且总计最多 20 GB；整站本机包默认保留 5 份且总计最多 20 GB。

## 低配电脑启动优化

- 管理后台与旧 Web 三维大屏已改为路由级按需加载。
- 只打开 Unity 内嵌后台时，前端基础入口由约 2.09 MB 降到约 100.55 KB；Three.js、ECharts 和旧 Web 场景不会再阻塞后台首屏。
- 三维/图表功能自身仍是较大的按需模块，但只在访问对应功能时下载和解析。

主要日志：

- `%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend.log`
- `%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend-error.log`
- `%APPDATA%\heat-treatment-digital-twin-desktop\logs\native-client.log`
- `%APPDATA%\heat-treatment-digital-twin-desktop\logs\native-client-error.log`
- `%APPDATA%\heat-treatment-digital-twin-desktop\logs\desktop-error.log`

## 安全加固记录

| Rule ID | 严重级别 | 原问题 | 已实施修复 |
| --- | --- | --- | --- |
| NET-001 | 高 | 管理 API 在误绑定所有网卡时可被局域网直接修改 | 非本机写请求默认 403；远程管理必须配置 `ADMIN_API_TOKEN` |
| HTTP-001 | 中 | Express 暴露 `X-Powered-By`，缺少浏览器安全头 | 移除框架指纹；增加 CSP、nosniff、SAMEORIGIN、Referrer-Policy、Permissions-Policy |
| CORS-001 | 高 | 默认 `cors()` 接受任意来源 | 默认只允许回环来源和明确配置的白名单 |
| DOS-001 | 中 | 普通 JSON 全局允许 50 MB | 默认降为 5 MB；备份/模型继续使用独立 multipart 限制 |
| DOS-002 | 中 | HTTP 超时未明确 | 增加 header/request/keep-alive 超时和请求头数量上限 |
| UPLOAD-001 | 高 | 模型文件名包含客户端原名，只按扩展名判断 | 服务端随机文件名；GLB 校验 magic/version/长度，GLTF 校验 JSON 和 glTF 2.x |
| BACKUP-001 | 高 | MySQL 被当作生产库，但原备份仅支持 SQLite | 新增 MySQL 一致性压缩备份、校验、恢复和回滚 |
| BACKUP-002 | 高 | 本机备份不能防整机丢失 | 新增定时整站 ZIP 和外部目录校验复制 |
| LOG-001 | 中 | 仅按天/数量清理，缺少目录总容量上限 | 新增归档总容量 250 MB 上限 |
| XSS-001 | 中 | 车间/产线名称通过 `innerHTML` 写入标签 | 改为 DOM `textContent`，用户输入不再解释为 HTML |
| CODE-001 | 高 | PLC 换算公式使用动态 JavaScript 求值 | 改为只支持 `x`、数字、四则运算和括号的受限解析器；禁止代码执行、无限结果、超长和深度嵌套公式 |

## 自动化命令

```powershell
cd backend
npm run test:plc
npm run test:plc-protocols
npm run test:datapoints-sync
npm run test:recovery
npm run test:mysql-backup
npm run test:site-backup
npm run test:production-readiness
npm run test:math-expression
npm run test:designer
npm run test:runtime
npm run test:native-dashboard
npm run test:spatial
npm run test:voice

cd ..\frontend
npm run build

cd ..
node desktop\scripts\log-manager-test.cjs
cd desktop
npm run test:supervisor
npm run test:admin-host-parent
```

## 现场上线清单

1. MySQL 服务设为 Windows 自动启动，并在 `my.ini` 设置 `bind-address=127.0.0.1`；Windows 防火墙不得把数据库端口开放到公网或办公网。
2. 为本软件建立只拥有目标数据库权限的专用账号，不使用 `root`。账号主机范围使用 `localhost`，现场密码不得写入脚本、截图或交付文档。
3. 安装兼容版本的 `mysqldump.exe` 与 `mysql.exe`；后台应显示 MySQL 自动备份可用。
4. 配置外部灾备目录，执行一次手工导出并在备用电脑恢复。
5. 配置 BIOS“来电自动开机”和专用 Windows 用户自动登录。
6. 将 PLC 交换机或 PLC 网线真实断开，记录现场坏质量、离线和恢复时间。
7. 按点表逐点核对地址、数据类型、比例、小数位、报警和语音。
8. 检查 Windows 防火墙：后端 3001 仅本机；仅按实际投屏方案开放局域网端口。
9. 连续运行至少 72 小时，观察日志目录、MySQL 数据量、CPU/内存、PLC 重连次数和最近一次备份状态。
10. 完成用户自行执行的电视投屏兼容性测试。
