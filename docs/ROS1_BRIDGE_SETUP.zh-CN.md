# ROS1 只读桥接部署说明

适用：Jetson/其他 ROS1 主机向平板查看器提供实时数据。这里的步骤是部署建议，未在生产机器人执行。合成测试服务器只用于开发测试，不能代替真实 ROS 桥接，也不能证明机器人已接通。

## 固定版本，先在测试环境构建

ROS1 已结束官方支持。Foxglove 的 ROS1 仓库目前处于维护阶段，并明确建议从源码构建，避免使用陈旧发行版二进制包。建议将桥接器与 ROS 环境作为一个可追溯制品保存，并固定完整 commit、依赖版本、构建日志和镜像摘要。

本交付文档核对的源码基线为 `42c0ba4fffeec88dc6890dd98ea2590e20bd4370`，不是“任何时间都最新版”的承诺，也不是该版本已通过全面安全审计。使用其他版本时，重新核对参数和服务器权限检查。

以下示例在独立测试工作区执行；不要直接在运行中的机器人系统升级依赖：

```bash
source /opt/ros/noetic/setup.bash
mkdir -p ~/tablet_bridge_test_ws/src
cd ~/tablet_bridge_test_ws/src
git clone https://github.com/foxglove/ros-foxglove-bridge.git bridge
cd bridge
git checkout --detach 42c0ba4fffeec88dc6890dd98ea2590e20bd4370
git rev-parse HEAD
cd ../..
rosdep update --include-eol-distros
rosdep install --from-paths src --ignore-src --rosdistro noetic -y
catkin_make install -DCMAKE_BUILD_TYPE=Release
source install/setup.bash
```

依赖安装会修改测试主机；应由系统负责人审核并执行。若平台仓库不再提供匹配包，使用已验证的内部镜像/依赖快照，不要临时混用不同 ROS 或 Ubuntu 发行版。

## 默认必须收紧为只读

随项目提供的 `ros1-readonly.launch` 使用真实存在的启动参数：

- `capabilities: []`：关闭客户端发布、参数 API、服务调用、资源抓取和连接图扩展；基本话题订阅无需额外 capability。
- `client_topic_whitelist`、`service_whitelist`、`param_whitelist`、`asset_uri_allowlist` 同时设为空数组，形成额外限制。
- `topic_whitelist` 使用首尾锚定的精确正则，只开放需要的可视化话题。按实际话题名修改，别把示例名误认为已有话题。
- 默认监听 `127.0.0.1`，防止刚启动就暴露在所有网卡上。这个默认值不能让另一台平板直接连接。
- `send_buffer_limit` 是每连接待发送缓冲上限。示例 4 MB 是起点，需要按最大单帧大小/带宽验证，不能据此声称延迟或性能已达标。

官方默认配置会启用客户端发布、参数、服务和资源等能力，而且默认绑定全部网卡。仅在平板 UI 中隐藏按钮不构成服务端只读保护。参数在启动时加载，改完须按变更流程重启桥接器。

先在测试环境启动：

```bash
roslaunch /absolute/path/to/docs/ros1-readonly.launch
```

然后验证 WebSocket 握手协商的是 `foxglove.websocket.v1`；服务端 `serverInfo.capabilities` 应为空数组，advertise 只包含允许的话题。使用隔离测试环境验证禁止发布/参数修改/服务调用；不要向真实执行器发送试探性指令。

## 平板网络连接

首选部署方式之一：

1. 保持桥接器绑定环回地址，由受控网络中的反向代理提供可信证书的 WSS，配置客户端身份验证、网络访问控制和限流。
2. 桥接器直接绑定专用机器人网卡地址，并配置 `tls:=true`、`certfile`、`keyfile`。证书域名/SAN 必须匹配平板使用的地址，且 Android/WebView 信任该证书链。仍需网络侧认证和访问限制。

示例参数形状如下，地址和证书由部署者填写：

```bash
roslaunch /absolute/path/to/docs/ros1-readonly.launch \
  address:=PRIVATE_ROBOT_INTERFACE_IP tls:=true \
  certfile:=/protected/path/server-chain.pem keyfile:=/protected/path/server-key.pem
```

不要将 8765 或 ROS Master 的 11311 端口映射到公网；不要忽略证书错误。TLS 只提供传输加密/服务器身份验证，不能自行替代用户授权。证书私钥留在 ROS 主机，不放入 APK、不发给平板。明文 WS 只适合受控隔离测试网络；不要为方便连接全局关闭 WebView 安全限制。

平板不需要安装 ROS、访问 ROS Master 或获取 SSH 密码。应用静态资源应打包到 APK 中。实时数据仍依赖到机器人的局域网连接，“离线安装”不等于“无网络也能看实时机器人”。

## 性能与故障排查

- 先用 1–5 Hz、下采样点云验证；再逐步增加。100,000 点 × 16 字节 × 10 Hz 约为 16 MB/s，未包含协议和 Wi-Fi 开销。
- `/tf` 和 `/tf_static` 都须可见。检查固定坐标系、消息 `header.stamp` 与 TF 的时钟来源，不能用网络收包时间替代采样时间。
- 缺 TF、消息不支持或 schema 解析失败应显示明确状态，不能把错误位置画成正确结果。
- 断线时应保留明确离线/陈旧状态；重连重新获取话题和静态 TF，避免拿上一台机器人的缓存冒充当前数据。
- 对比桌面 RViz 的同一 rosbag 或测试节点数据、同一 fixed frame 和同一时间。合成测试通过后仍需执行真实桥接/真机验收。

## 官方依据

核对日期：2026-10-17。

- [ROS1 桥接器官方仓库与构建说明](https://github.com/foxglove/ros-foxglove-bridge)
- [固定源码基线](https://github.com/foxglove/ros-foxglove-bridge/commit/42c0ba4fffeec88dc6890dd98ea2590e20bd4370)
- [固定版本启动参数](https://github.com/foxglove/ros-foxglove-bridge/blob/42c0ba4fffeec88dc6890dd98ea2590e20bd4370/ros1_foxglove_bridge/launch/foxglove_bridge.launch)
- [Foxglove v1 协议原始规范](https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md)：该仓库已归档，官方标明规范/库已弃用；本项目锁定兼容的 ROS1 协议子集，不把它当作未来演进保证。
- [ROS1 PointCloud2 消息定义](https://github.com/ros/common_msgs/blob/noetic-devel/sensor_msgs/msg/PointCloud2.msg)
