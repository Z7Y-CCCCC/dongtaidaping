# 智能热处理数字孪生控制中心 (Smart Heat Treatment Digital Twin)

本项目是一个专为智能热处理车间开发的高性能 **3D 数字孪生与组态管理大屏系统**。系统通过对车间设备进行三维建模与可视化展现，并实时连接工业现场数据源（西门子 PLC / MQTT / 仿真数据），为热处理生产线（多用炉、回火炉、清洗机、料车等）提供多级视角的监控、警报以及单机详细透视诊断能力。

---

## 🚀 系统特色

1. **多层级 3D 交互运镜**：
   - 支持 **“工厂全局 ➔ 车间级 ➔ 产线级 ➔ 单机诊断”** 4 级平滑相机飞行过渡。
   - 点击设备即可完成视角自适应定位。
   
2. **设备透视与诊断 (X-Ray Mode)**：
   - 进入单机详情时，自动隐藏非激活设备，开启目标设备的 **X-Ray 透视诊断模式**（外壳半透明化）。
   - 可无阻碍观察红热的自发光炉膛、工件料盘、物料小车的实时动作。
   - 三维动态渲染：电机启停（自发光与旋转动画）、炉门垂直升降、推链平移、淬火槽油位和油泵指示灯状态。

3. **双通道数据采集与控制引擎**：
   - **方案 A (MQTT 模式)**：PLC ➔ C# 上位机 ➔ MQTT 代理（Broker） ➔ 前端 WebSocket。
   - **方案 B (S7 直连模式)**：Node.js 后端使用 `nodes7` 库直连西门子 S7 协议 PLC 通信，经 WebSocket 直接分发前端，无需中转。
   - **模拟模式 (Simulation)**：内置高仿真随机算法，模拟温度、碳势的布朗运动微小波动、装料/取料工艺节拍动画及故障警报。

4. **苹果风格极简管理后台 (AdminPanel)**：
   - 包含：车间管理、产线管理、设备管理、3D模型库、现场编排器、点位映射、连接设置。
   - UI 采用了 Apple 极简与磨砂玻璃设计规范：iPadOS 风格 Sidebar、Action Blue 系统蓝高亮、macOS Sheet 模态挂载弹性动画、iOS 控制中心式状态监控。

5. **模型几何化快速建型工具**：
   - `tools/` 目录下提供了 Blender 生成脚本，能够基于现场的真实设备照片自动组合生成低多边形（Low-Poly）的 3D 模型文件。

---

## 🛠️ 项目目录结构

```text
├── backend/                   # Node.js 后端服务 (Express, better-sqlite3)
│   ├── assets/models/         # 3D 静态模型资源 (内置与生成的 .glb/.blend 格式)
│   ├── db/                    # 数据库设计与factory.db初始化
│   ├── routes/                # 平台管理 API 路由 (组件编排、设备、点位等)
│   ├── services/              # 核心服务 (数据引擎、S7连接器、模拟器)
│   └── server.js              # 后端主入口
├── frontend/                  # 前端 Vue 3 大屏可视化项目 (Vue 3, Vite, Three.js, ECharts)
│   ├── src/
│   │   ├── three/             # 3D 渲染核心 (SceneManager, FurnaceModel, ModelFactory)
│   │   ├── runtime/           # 大屏运行时、DataStore 与小部件渲染
│   │   ├── views/             # 视图页面 (AdminPanel 苹果风管理台)
│   │   └── App.vue            # 大屏控制中心与响应式 UI 布局
│   └── vite.config.js
├── mock-server/               # MQTT 仿真数据上报脚本 (演示用)
├── tools/                     # Blender 自动化建型 Python 脚本
├── 回火炉/                    # 回火炉设备实物参考照片
├── 多用炉/                    # 多用炉设备实物参考照片
├── 清洗机/                    # 清洗机设备实物参考照片
└── 小车/                      # 运输小车设备实物参考照片
```

---

## ⚙️ 快速上手

### 1. 运行后端服务
```bash
cd backend
npm install
npm start
```
后端服务将运行在 `http://localhost:3001`。首次启动会自动创建并初始化 `backend/data/factory.db` 数据库。

### 2. 运行前端大屏与管理后台
```bash
cd frontend
npm install
npm run dev
```
打开浏览器访问前端面板：
- **数字孪生大屏**：`http://localhost:5173/`
- **后台管理终端**：`http://localhost:5173/admin`

### 3. 运行数据模拟器 (可选)
如果需要联调 MQTT 链路，可以运行模拟上报脚本：
```bash
cd mock-server
npm install
node mqtt-simulator.js
```

---

## 📦 备份与推送

本项目代码与参考物料照片均保存在本地，可通过 Git 进行统一的版本控制和备份：
```bash
git add .
git commit -m "docs: add README.md & backup full project workspace code"
git push origin main
```
