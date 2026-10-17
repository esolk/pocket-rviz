# pocket-rviz：掌上 ROS1 可视化原型 v0.1.1

目标设备：7 英寸手机横屏。重新实现 ROS1 常用可视化，不是原版 RViz 的 Android 移植版，不兼容桌面 C++ 插件。

## 先试用

1. 按下方说明从本仓库构建 APK，再自行安装到测试设备。本仓库暂不发布预编译 APK。
2. 在应用内选择离线演示，检查横屏布局、旋转、平移、缩放、俯视和图层开关。演示中的数据全部为合成数据。
3. 真实连接前，按 `docs/ROS1_BRIDGE_SETUP.zh-CN.md` 在独立测试环境准备 ROS1 Foxglove bridge。此应用不连接 rosbridge JSON 的 9090 端口。
4. 在手机填写桥接地址，例如 `ws://192.0.2.1:8765`；这是文档占位地址，请换成受控局域网中的真实机器人地址，选择真实存在的固定坐标系和话题。默认只读，不发送车辆控制指令。

Android 最低 API 24，但三维显示还要求设备 GPU 与 Android System WebView 支持 WebGL 2。最低系统版本并不保证所有旧设备可用。没有可用 WebGL 2 时会显示兼容性说明。

## v0.1.1 更新

新增分层连接状态、最近事件日志、关闭码、用户点击触发的手机 DNS/TCP/Ping 辅助检测与可复制报告。修复旧版等待话题提示残留及重连状态问题。更新和排查步骤见 `docs/DIAGNOSTICS_0.1.1.zh-CN.md`。

## 交付内容

- `web/`：Three.js 可视化、手机交互、Foxglove 协议客户端、CSP 安全的 ROS1 二进制解释解析器、离线演示与单元测试。
- `android/`：Java Android 外壳、本地 HTTPS 资源加载、前后台与返回键处理、安全区域适配。
- `scripts/android-*.sh`、`scripts/android-verify.py`：SDK 安装、APK 构建与验证。安装 SDK 需要自行遵守 Google Android SDK 许可协议。
- `qa/`：独立 Python 合成桥接服务器、序列化测试、浏览器验收工具。
- `docs/`：ROS1 只读桥接部署示例、验收说明。
- `web/README.md`：逐项功能、编码支持、性能限制与未实现清单。

## 当前边界

已实现的原型范围包括 PointCloud2、LaserScan、TF/static TF、OccupancyGrid、Path、Odometry/PoseStamped、常用 Marker、部分 Image 编码与 JPEG/PNG CompressedImage，以及通用消息字段查看。

URDF RobotModel、网格资源 Marker、InteractiveMarker、导航目标发布、rosbag/MCAP 文件回放及完整 RViz 配置兼容尚未实现。部分 Marker 外观和寿命语义有明确限制，见 Web README。此版本不应被表述为完整 RViz 替代品。

公开源码的复核范围见 [验证记录](docs/VALIDATION.zh-CN.md)。尚未完成物理 Android 手机或真实 ROS 主机验收，也没有手机 GPU、触摸、发热与续航实测。

## 从源码构建

```sh
cd web
npm ci
npm test
npm run build
cd ..
# 先阅读 android/README.md 完成官方 SDK 安装和许可证确认。
bash scripts/android-build.sh
```

SDK、node_modules、调试签名私钥和中间构建目录不随源码交付。重新构建会使用你的本地调试密钥；与已有 APK 签名不同的版本通常需要卸载旧版再安装。卸载会清除本地偏好。应用内只保存非敏感连接/显示偏好，没有账号或生产签名密钥。

## 下一步实机验收

使用同一 rosbag 或测试节点，与桌面 RViz 对齐固定坐标系、时间与图层；逐项核对点云、TF、地图、路径、标记增删及图像。先低频/低点数，再提高负载。记录手机型号、Android/WebView 版本、输入点数/频率、帧率、延迟、峰值内存和运行时长。步骤见 `docs/ACCEPTANCE.zh-CN.md`。

## 许可证与第三方依赖

项目自身尚未选定开源许可证；公开可见不等于授予重新使用、修改或分发许可。第三方依赖各自的许可证不受影响，完整声明见 [THIRD_PARTY_NOTICES.txt](web/public/THIRD_PARTY_NOTICES.txt)。
