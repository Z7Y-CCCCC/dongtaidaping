# 动态大屏 / 热处理数字孪生控制中心

这是一个面向热处理车间的 3D 数字孪生大屏与后台组态系统。项目包含前端大屏、管理后台、Node.js 后端、MySQL 配置库、PLC 采集链路、模拟数据链路、3D 模型资产管理、组件配置和报警/指标展示。

仓库地址：[https://github.com/Z7Y-CCCCC/dongtaidaping](https://github.com/Z7Y-CCCCC/dongtaidaping)

## 功能概览

- **3D 大屏**：基于 Vue 3 + Three.js 展示工厂、车间、产线、设备层级。
- **设备模型动画**：支持将 PLC 点位绑定到炉门、风扇、油搅拌等模型动作。
- **PLC 数据采集**：后端内置 nodes7 S7 采集器，通过 WebSocket 推送实时数据。
- **离线演示/模拟数据**：后台可切换到模拟模式，不接 PLC 也能演示。
- **设备离线判定**：PLC 连接或重连超过阈值后进入 `offline/bad`，前端自动置灰。
- **后台组态**：车间、产线、设备、点位、模型资产、组件布局、设备浮标、诊断面板等可配置。
- **报警跑马灯**：报警履历支持配置显示条数与时间范围。
- **数据库可切换**：默认 MySQL/MariaDB；代码保留 SQLite、PostgreSQL、SQL Server 适配入口。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 前端 | Vue 3、Vite、Three.js、GSAP、ECharts |
| 后端 | Node.js、Express、WebSocket(ws)、nodes7 |
| 开发默认数据库 | MySQL/MariaDB |
| Windows 安装版数据库 | 本地 SQLite（WAL + 全同步写入） |
| 可选数据库 | PostgreSQL、SQL Server |
| 工具 | Blender Python 建模脚本、PLC 模拟脚本 |

## 目录结构

```text
backend/                    后端服务
  assets/models/            3D 模型资产、预览图
  db/database.js            数据库连接、建表、种子数据
  db/init-mysql.sql         可选的 MySQL 空库创建脚本
  routes/                   后台管理 API
  services/                 数据引擎、PLC 采集器、模拟器、WebSocket
  server.js                 后端入口
frontend/                   Vue 3 大屏与管理后台
  src/App.vue               大屏入口
  src/views/AdminPanel.vue  管理后台
  src/runtime/              实时数据、组件渲染、运行时配置
  src/three/                3D 场景和模型渲染
mock-server/                辅助模拟服务
tools/                      Blender 与动画验证工具
docs/                       项目文档
多用炉/ 回火炉/ 清洗机/ 小车/  现场设备参考图
```

## 环境要求

- Node.js：建议 18+，最低 16+。
- MySQL 或 MariaDB：默认连接参数如下：
  - Host：`127.0.0.1`
  - Port：`3307`
  - User：`root`
  - Password：`root`
  - Database：`dongtai_daping`
- 可选：Blender 3.x+，只在重新生成模型资产时需要。

> 注意：本项目默认要求安装 MySQL/MariaDB。SQLite 只是代码保留的可选适配，不是默认运行方式。

## 数据库初始化说明

项目**不依赖完整 SQL dump 文件**。

后端启动时会自动完成这些动作：

1. 读取数据库配置。
2. 自动创建 `dongtai_daping` 数据库（账号需要有 `CREATE DATABASE` 权限）。
3. 自动创建所有表。
4. 自动插入默认项目、场景、组件、设备、点位模板等种子数据。

对应逻辑在：

```text
backend/db/database.js
```

如果你的数据库账号没有建库权限，可以先手动执行这个可选 SQL：

```bash
mysql -uroot -proot -P3307 < backend/db/init-mysql.sql
```

这个 SQL 只负责创建空库；表结构和默认数据仍由后端启动时自动生成，避免 SQL 文件和代码里的结构不同步。

## 快速启动

### 1. 克隆项目

```bash
git clone https://github.com/Z7Y-CCCCC/dongtaidaping.git
cd dongtaidaping
```

### 2. 准备 MySQL/MariaDB

确保本机 MySQL/MariaDB 已启动，并监听 `3307` 端口。

如果你用的是本机 MySQL 默认 `3306`，可以二选一：

1. 把 MySQL 端口改到 `3307`；或
2. 用环境变量覆盖端口：

```powershell
$env:MYSQL_PORT="3306"
```

也可以手动创建空库：

```sql
CREATE DATABASE IF NOT EXISTS dongtai_daping CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 启动后端

```bash
cd backend
npm install
npm start
```

后端默认地址：

- API：`http://localhost:3001/api`
- 健康检查：`http://localhost:3001/api/health`
- WebSocket：`ws://localhost:3001/ws`

### 4. 启动前端

另开一个终端：

```bash
cd frontend
npm install
npm run dev
```

打开：

- 大屏：`http://localhost:5173/`
- 后台：`http://localhost:5173/admin`

## 大屏渲染性能档位

后台“系统设置 → 大屏渲染性能”可以按部署电脑配置选择：

| 档位 | 目标帧率 | 渲染分辨率 | 适用场景 |
| --- | ---: | ---: | --- |
| 低配兼容 | 30 FPS | 75% | 无独显、4K 大屏或较老电脑 |
| 均衡 | 45 FPS | 100% | 普通核显，兼顾清晰度和流畅度 |
| 流畅 | 60 FPS | 100% | 性能较好的核显或普通独显 |
| 高画质 | 60 FPS | 125% | 有独显的展示电脑 |
| 自定义 | 15-144 FPS | 50%-150% | 工程师按现场实测调整 |

自定义档还可以控制 WebGL 抗锯齿和 3D 浮标刷新率。保存后刷新大屏页面生效。

## 数据库配置

默认配置在 `backend/db/database.js`：

```js
{
  type: 'mysql',
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'root',
  database: 'dongtai_daping'
}
```

支持通过环境变量覆盖：

| 环境变量 | 说明 |
| --- | --- |
| `DB_TYPE` | `mysql` / `mariadb` / `sqlite` / `postgres` / `sqlserver` |
| `DB_HOST` 或 `MYSQL_HOST` | 数据库地址 |
| `DB_PORT` 或 `MYSQL_PORT` | 数据库端口 |
| `DB_USER` 或 `MYSQL_USER` | 用户名 |
| `DB_PASSWORD` 或 `MYSQL_PASSWORD` | 密码 |
| `DB_NAME` 或 `MYSQL_DATABASE` | 数据库名 |
| `SQLITE_FILE` | SQLite 数据库文件 |

## SQLite 断电恢复与备份

Windows 安装版默认使用 SQLite，并启用以下保护：

- `WAL` 日志模式与 `synchronous=FULL`，降低突然断电造成已提交数据丢失或主库损坏的风险。
- 每次启动、每 6 小时、正常退出时自动创建一致性备份，默认保留最近 10 份。
- 启动时执行 `quick_check`；主库损坏时隔离原数据库及 WAL/SHM 文件，并从最新有效备份恢复。
- 后台“数据库连接 → 本机自动备份”支持立即备份、下载和手工恢复；恢复前会自动生成回滚备份。
- 本机自动备份仍与现场电脑存放在一起，只防断电和数据库损坏，不防电脑丢失或硬盘损坏。

安装版数据默认位于：

```text
%APPDATA%\heat-treatment-digital-twin-desktop\data\factory.db
%APPDATA%\heat-treatment-digital-twin-desktop\data\backups\
%APPDATA%\heat-treatment-digital-twin-desktop\data\recovery\
```

## 运行日志与错误日志

Windows 安装版会把日志保存在当前用户的应用数据目录：

```text
%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend-error.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\desktop-error.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\*.log.gz
```

`backend.log` 是后端正常运行日志，`backend-error.log` 是后端标准错误日志，`desktop-error.log` 是桌面壳和后端进程异常日志。单个活动日志默认达到 10 MB 自动切卷并 gzip；压缩日志默认保留 30 天、最多 60 个，软件运行期间每 6 小时自动清理。可通过 `LOG_MAX_BYTES`、`LOG_RETENTION_DAYS`、`LOG_MAX_ARCHIVES` 环境变量调整，单位分别是字节、天和文件数。

工程师做隔离诊断时可设置 `APP_USER_DATA_DIR` 指定应用数据目录；未设置时仍使用 Windows 当前用户的默认应用数据目录。

### 整站灾备（电脑丢失后在新电脑恢复）

后台“数据库连接 → 整站灾备（防电脑丢失）”可导出 ZIP，内容包括一致性 SQLite 数据库、数据库中的全部现场配置、全部现场上传模型，以及逐文件 SHA-256 清单。安装版导出时会弹出“另存为”，应选择 U 盘、移动硬盘或 NAS，不能只保存在现场电脑上。

新电脑恢复流程：

1. 安装同版本或更新版本的软件并启动。
2. 打开后台“数据库连接 → 整站灾备”。
3. 点击“从整站备份恢复”并选择 ZIP。
4. 恢复完成后核对设备、PLC 点位和模型，并重新进行现场连通验收。

导入前会创建数据库回滚备份，失败时会恢复原上传文件；灾备包不会把旧电脑的绝对数据库路径写入新电脑。内置模型随安装包交付，不在 ZIP 内重复保存。

安装版会注册 Windows 登录后自动启动。若要求停电来电后无人值守恢复展示，还必须在现场电脑 BIOS 中开启来电自动开机，并为专用展示账号配置 Windows 自动登录。

后台也有“数据库连接”配置入口。保存后后端会重连数据库并重启数据引擎。

## 数据模式

后台路径：`/admin` → **连接设置**。

- **内置低延迟采集**：`integrated_plc`，默认模式，后端直接连接 S7 PLC。
- **模拟数据**：`simulation`，离线演示用，不依赖 PLC。

默认是 `integrated_plc`。如果本地没有 PLC，设备会在超过离线阈值后变灰，这是正常表现。要做离线演示，请切到模拟数据。

## PLC 离线阈值

PLC 状态分两段：

1. 刚启动或短时间断线：`connecting` / `retrying`，质量为 `stale`。
2. 超过阈值仍无有效连接或读数：`offline`，质量为 `bad`，前端设备置灰。

默认阈值：15 秒。

可通过环境变量调整：

```powershell
$env:PLC_OFFLINE_AFTER_MS="30000"
```

## 报警跑马灯时间范围

后台路径：`/admin` → **组件配置** → `widget_marquee`。

默认配置：

```json
{
  "speed": 30,
  "limit": 20,
  "eventWindowHours": 24
}
```

含义：

- `speed`：滚动动画时长，单位秒。
- `limit`：最多显示多少条报警/事件。
- `eventWindowHours`：只显示最近多少小时的报警记录；设为 `0` 表示不限制时间。

后端接口示例：

```text
GET /api/platform/events?limit=20&window_hours=24
```

## 常用后台入口

- 车间 / 产线 / 设备配置
- PLC 点位映射
- 模型资产上传与节点绑定
- 模型动画绑定
- 组件配置与布局
- 设备浮标配置
- 诊断面板配置
- 数据库连接设置

## 常见问题

### 1. 后端启动失败，提示数据库连接失败

检查 MySQL/MariaDB 是否启动，以及端口、账号密码是否和默认配置一致。默认是：

```text
127.0.0.1:3307
root/root
dongtai_daping
```

如果你的 MySQL 是 `3306`：

```powershell
$env:MYSQL_PORT="3306"
cd backend
npm start
```

### 2. 没有 PLC，设备为什么变灰？

这是正确状态。默认 `integrated_plc` 模式会尝试连接 PLC；超过离线阈值后设备进入 `offline/bad`，大屏置灰。要做离线演示，请在后台切换到“模拟数据”。

### 3. 跑马灯没有报警记录

默认只显示最近 24 小时的事件。可以在后台 `widget_marquee` 里修改 `eventWindowHours`，或者临时请求：

```text
http://localhost:3001/api/platform/events?limit=50&window_hours=0
```

### 4. 前端能打开但没有数据

检查：

- 后端是否启动：`http://localhost:3001/api/health`
- WebSocket 是否可连：`ws://localhost:3001/ws`
- 后台数据模式是否为模拟，或 PLC 是否在线

## 构建

前端生产构建：

```bash
cd frontend
npm run build
```

后端语法检查示例：

```bash
node --check backend/server.js
node --check backend/services/plcReader.js
```

PLC 与断电恢复集成测试：

```bash
cd backend
npm run test:plc
npm run test:recovery
npm run test:site-backup
```

PLC 测试默认从相邻的 `排产/PLC仿真调试器` 启动 Snap7 服务，所有数据库与日志均写入项目的 `output/` 隔离目录。

Windows 客户安装包：

```bash
cd desktop
npm install
npm run dist
```

安装包输出到项目根目录的 `安装包/`。安装后无需另行安装 Node.js、数据库或浏览器；客户数据默认保存在 Windows 用户应用数据目录，卸载时不会自动删除。

## 提交说明

仓库提交源码、模型资产、后台配置逻辑和工具脚本。

不会提交：

- `node_modules`
- 运行日志
- 本地数据库配置 `backend/data/database-config.json`
- 本地 SQLite 文件
- 前端构建产物 `frontend/dist`
