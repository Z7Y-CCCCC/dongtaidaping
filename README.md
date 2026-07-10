# 智能热处理数字孪生控制中心 (Smart Heat Treatment Digital Twin Center)

本项目是一个专门针对工业热处理生产线（包括箱式气氛多用炉、回火炉、清洗机、轨道料车及取料小车等）开发的高性能 **3D 数字孪生与低代码组态管理大屏系统**。

系统集成了前端 3D 渲染表现与后端多协议工业级数据链路。支持将现场实物设备进行快速低多边形（Low-Poly）高拟真三维几何构建，并将现场 PLC 数据流（或 MQTT 数据流、高仿真调试数据流）与 3D 设备组件动作进行动态双向绑定，实现车间的实时透明化诊断和指标可视化。

---

## 🚀 系统技术栈与核心特色

### 1. 技术栈体系
- **前端 (Frontend)**：Vue 3 (Setup 组合式 API) + Vite + Three.js + GSAP + ECharts + WebSocket (客户端)
- **后端 (Backend)**：Node.js Express + SQLite (better-sqlite3) + nodes7 (西门子 PLC 专用通信库) + ws (WebSocket 服务端)
- **仿真与工具层**：MQTT 数据仿真上报模拟器 + Blender-Python 三维设备快速拼装建模工具

### 2. 核心功能特色
- **四级工业飞行运镜**：支持 **“工厂全局 ➔ 车间级 ➔ 产线级 ➔ 单机诊断”** 4 层级平滑相机镜头切换。
- **X-Ray 透视诊断模式**：在单机特写下，外壳和不必要框架的透明度在 1 秒内自动渐变为 `0.15`。暴露出被选设备内部的红热自发光加热膛（发光强弱随实时温度变化）、贯穿底部的推链机构以及放置于料盘内的工件，便于直观诊断。
- **设备工艺动画实时映射**：电机运行（带旋转叶片动画与绿/灰状态灯）、升降炉门高度位移、推拉链前推位移、油泵状态与淬火槽油液面透明表现均与实时测点绑定。
- **Apple 风格极简管理后台**：通过 iPadOS 侧栏和毛玻璃效果重新装修了配置后台，使连接设置、组态编排、模型上传、点位映射工作极具现代科技感。

---

## 📂 项目目录结构说明

```text
├── backend/                   # 后端服务
│   ├── assets/models/         # 3D 静态模型资源 (内置与生成的 .glb/.blend 格式)
│   ├── data/                  # factory.db 时序快照与配置数据库 (SQLite)
│   ├── db/                    # 数据库初始化脚本与种子数据 (database.js)
│   ├── routes/                # 平台管理 API (车间、产线、设备、点位、场景、组态组件接口)
│   ├── services/              # 核心业务服务 (数据采集总控、PLC 直连、数据模拟器等)
│   └── server.js              # 后端主入口
├── frontend/                  # 前端大屏与管理后台 (Vue 3, Vite)
│   ├── public/                # 公共静态资源
│   ├── src/
│   │   ├── three/             # 3D 渲染引擎 (SceneManager.js, FurnaceModel.js, ModelFactory.js)
│   │   ├── runtime/           # WebSocket 通信层 (DataStore.js), 运行时总线与 Widget 渲染
│   │   ├── views/             # 视图页面 (包含 Apple 风格重装修的 AdminPanel.vue)
│   │   └── App.vue            # 大屏控制中心与大屏 UI 布局
│   └── vite.config.js
├── mock-server/               # MQTT 数据仿真上报器 (供方案 A 调试使用)
├── tools/                     # Blender 自动化几何建模 Python 脚本
├── 多用炉/                    # 多用炉设备实物参考照片 (用于 3D 模型拼装对照)
├── 回火炉/                    # 回火炉设备实物参考照片
├── 清洗机/                    # 清洗机设备实物参考照片
└── 小车/                      # 轨道运输料车设备实物参考照片
```

---

## ⚙️ 快速开始

### 1. 运行环境要求
- **Node.js**：v16.x 或更高版本。
- **Blender**（可选）：v3.x 或更高版本，仅在使用 `tools/` 模型自动生成脚本时需要。

### 2. 启动步骤

#### 步骤 A：运行后端服务与配置中心
首次启动服务时，后端会自动在 `backend/data/` 目录下创建并初始化 `factory.db` 数据库文件，并置入默认的 4 条热处理产线和 20 台设备数据。
```bash
cd backend
npm install
npm start
```
- 服务端口：`3001`
- 接口验证：`http://localhost:3001/api/health`

#### 步骤 B：运行前端大屏与苹果风管理端
```bash
cd frontend
npm install
npm run dev
```
启动成功后，可在浏览器中打开以下页面：
- **数字孪生大屏 (实时展示端)**：[http://localhost:5173/](http://localhost:5173/)
- **管理配置终端 (管理端)**：[http://localhost:5173/admin](http://localhost:5173/admin)

#### 步骤 C：启动独立的数据模拟上报服务 (可选)
如果您选择了方案 A (MQTT 通路) 且需要模拟 PLC 数据的产生并发布到外部 MQTT Broker 上，请运行该模拟器：
```bash
cd mock-server
npm install
node mqtt-simulator.js
```

---

## 🔌 数据通路方案与配置指南

系统支持三种不同的数据通路，可通过管理终端的 `连接设置` 页面进行热切换。

### 方案 A：MQTT 桥接通道 (C# 上位机上报模式)
此方案适用于现场已经有 C# 编写的上位机软件直接通过 PLC 读取数据，并将数据发送至 MQTT 服务器的场景。
1. **数据通路**：`西门子 PLC ➔ C# 上位机 ➔ MQTT Broker ➔ 后端 WebSocket ➔ 前端大屏`。
2. **Broker 配置**：在后台配置 `mqtt_broker`（由于浏览器限制，必须填写 WebSocket 协议的 Broker 地址，如 `ws://broker.emqx.io:8083/mqtt`）及 `mqtt_topic_prefix`（主题前缀）。
3. **上报数据 JSON 格式规范**：上位机每次应向 `[topic_prefix]/[device_id]` 主题发送包含以下结构的 JSON 报文：
   ```json
   {
     "furnace_id": "Furnace_01",
     "timestamp": 1718451120000,
     "analog": {
       "actual_temp": 855.4,
       "setpoint_temp": 860.0,
       "actual_carbon": 0.812,
       "setpoint_carbon": 0.850
     },
     "status": {
       "running": true,
       "alarm": false
     },
     "motors": {
       "fan_motor": true,
       "stir_motor": true,
       "oil_pump": false
     },
     "doors": {
       "front_door_open": false,
       "middle_door_open": false
     },
     "mechanisms": {
       "push_chain_forward": false
     }
   }
   ```

### 方案 B：Node.js 后端直连 S7 PLC (免上位机直接读取)
此方案适用于无中间上位机程序，后端直接通过工业以太网接口与西门子 PLC 保持长连接并抓取时序测点的场景。
1. **数据通路**：`西门子 PLC (TCP 102) ➔ Node.js 后端 nodes7 服务 ➔ WebSocket ➔ 前端大屏`。
2. **前置 PLC 设置 (TIA 博途环境)**：
   - 必须在 PLC 属性中勾选：**“允许来自远程伙伴(PLC、HMI、OPC...)的 PUT/GET 通信”**。
   - 测点存储的 DB 数据块必须**取消勾选“优化的块访问”**（以确保使用传统的偏移地址寻址方式）。
3. **连接配置**：
   - 在管理端的 `连接设置` 中，配置 PLC 的 `PLC IP 地址`、机架号 (`Rack`，默认 0)、插槽号 (`Slot`，根据实际 PLC 如 S7-1200 为 1) 以及 `轮询间隔`。
4. **点位映射配置 (`c:\Users\27323\OneDrive\Desktop\大屏\backend\routes\datapoints.js`)**：
   在管理端的 `点位映射` 选项卡下，可以为每台设备指定测点到西门子地址的映射关系：
   - **温度测点**：映射到 `DB1.DBD10`，数据类型选择 `REAL` (DBD float)，用于接收浮点温度。
   - **运行状态**：映射到 `DB1.DBX0.0`，数据类型选择 `BOOL`，接收数字开关量。
   - 比例（`scale`）与偏移（`offset`）：系统会自动将采集到的原始值应用公式：`value * scale + offset` 进行工程单位换算。

### 方案 C：内置高仿真模拟模式
专为离线演示与功能验收开发，数据在 `backend/services/simulator.js` 中动态计算产生：
- **物理运动模拟**：实际温度采用布朗运动概率波动算法模拟加热器运行，在设定温度附近实现平滑漂移；实际碳势亦做小幅随机震荡。
- **动作工况模拟**：模拟器包含计数器，每隔一定时间依次将 `doors.front_door_open`、`doors.middle_door_open` 以及 `mechanisms.push_chain_forward` 置为 `true` 或 `false`，从而在前端大屏展现完整的炉门上升、推链进料、推链退回、炉门下降等生产工艺循环。

---

## 🧩 组态编排与页面搭建工作流

大屏支持对页面布局和绑定关系的低代码（Low-Code）现场编排：

### 1. 设备模型空间布置
在管理后台的 `设备管理` 选项卡：
- 可以对设备进行新建与克隆，指定每个设备的 3D 实例化参数：**X/Y/Z坐标值、缩放比例(scale)、旋转角度(rotation_y)**。
- 3D 渲染引擎会自动读取数据库内的位置矩阵并在画布中拼装整个车间环境，无需硬编码定位。

### 2. UI 组件布局编排
在管理后台的 `现场编排` 选项卡：
- **网格定位**：场景通过 `layout_json` 定义了 24x12 的大屏定位网格。可以为每个组件（例如生产指标 widgets, 趋势图 widgets）指定坐标 `(x, y)` 和尺寸 `(w, h)`。
- **数据绑定 (`binding_json`)**：每个组件可配置绑定的字段数据。如趋势图组件绑定 `{"path": "metrics.current_output"}`，时序折线图就会自动接入后端记录的时序快照数据进行动态绘制。

---

## 🎨 实物模型建型 Python 脚本指南

为了基于车间设备照片快速生成 3D 低多模，`tools/` 文件夹内置了 Blender Python 生成脚本：

### 1. 生成原理
Blender 脚本会自动读取设定的几何和材质参数：
- 使用 `detail_multipurpose()` 等装饰函数，基于 Three.js 拼装低模的炉壳主体；
- 运用脚本接口，通过坐标数组自动在钣金边缘和法兰侧面打入大量的螺栓固件 (`add_bolts`)；
- 在排气和散热区自动排布冷拉板缝线条 (`add_panel_seams`) 与通风散热孔 (`add_grille`)；
- 自动拼接电缆曲线与弯头油管管道，最终在虚拟厂房地板上成列排布，渲染输出高拟真的模型预览图，并导出成 `.glb` 文件供前端大屏直接使用。

### 2. 如何运行脚本
请在您的系统中确认 `blender` 命令行可执行。打开命令行并执行：
```bash
# 执行 V2 版建型脚本
blender --background --python tools/blender_generate_photo_equipment_models_v2.py
```
生成的 `.glb` 文件将会自动导出，可上传或复制至 `backend/assets/models/` 目录下供设备绑定使用。

---

## 📦 版本备份与发布

在完成了配置调整或模型重构后，请使用以下命令完成代码的持久化备份与团队同步：
```bash
# 暂存当前所有的数据库结构、Blender模型及前后端源码
git add .

# 提交本地备份
git commit -m "docs: add detailed README.md & backup latest production configurations"

# 推送到指定的 GitHub 远程分支
git push origin main
```
