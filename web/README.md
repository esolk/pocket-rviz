# 掌上 RViz Web Core

面向 **7 英寸手机横屏** 的轻量 ROS1 只读三维查看器。主要交互尺寸为 915×412 / 800×360 CSS 像素，竖屏可用。单个全屏场景，默认收起图层抽屉，底部触控操作，安全区域适配。它是重新实现的 RViz 风格查看器，不是原版 RViz 的 Android 编译版，也不支持 RViz C++ 插件。

## 运行与构建

需要 Node.js 20.19+ / 22.12+（当前验证 Node 24）。

```sh
npm ci
npm test
npm run build
npm run dev
```

`dist/` 是完整静态发行内容，资源相对路径，所有 JavaScript/CSS 本地打包，无运行时 CDN、云服务或远程字体。Android 外壳应从本地资源加载 `dist/index.html`，不能只复制 index.html。正式包应使用 `npm ci` 保持 lockfile 中的精确依赖。

需要现代 **WebGL 2** 浏览器 / Android System WebView。无法创建 GPU 上下文时显示明确兼容性提示和重试，不把静态假画面当作正常显示。

## 连接真实机器人

1. 在 ROS1 机器人上运行 Foxglove bridge，确认正在广播需要的 topic 与 TF。
2. 手机加入相同网络或已配置的 VPN。
3. 打开连接窗口，填写 `ws://机器人IP:8765` 或已正确配置证书的 `wss://…`。
4. 图层抽屉中勾选需要的消息；固定坐标系默认 `map`，可改为 `odom` 等真实存在的 frame。

要求 **foxglove.websocket.v1** 子协议、消息编码 `ros1`、广告消息包含完整 ROS1 schema（schemaEncoding 如提供，应为 `ros1msg`）。不兼容 rosbridge 9090 的 JSON 协议，不支持 ROS2 CDR。

协议使用 MIT 的 `@foxglove/ws-protocol` 0.8.0；实现前检查其 `src/FoxgloveClient.ts`、`src/parse.ts` 与[官方协议](https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md)。该仓库已归档，使用明确锁定版本，未来维护应关注 bridge 兼容性和上游替代品。

ROS schema 由 `@foxglove/rosmsg` 解析。正式运行使用项目自己的 `SafeMessageReader` 解释式解析器，**不使用 eval / new Function**，兼容 `script-src 'self'`。Foxglove 的 `rosmsg-serialization` 仅作为开发测试的交叉验证依赖，其动态代码生成解析器不会打进运行时。

界面唯一会发出的协议操作是 subscribe / unsubscribe。不发布 ROS 消息、不调用服务、不修改参数、不连接机器人控制接口。网络中断会明确提示旧画面已停止更新并按 1–15 秒指数退避重连；重连清空旧会话数据、重新发现及订阅话题。用户主动断开立即清空场景。

## 已实现

- 点云 `sensor_msgs/PointCloud2`：组织型 cloud、row_step 行填充、字段 offset/count、大小端、全部 8 种数值 datatype；丢弃 NaN/Infinity。支持选择 packed rgb/rgba、intensity、相对高度、固定颜色或自动着色。每层独立设置点大小、不透明度与采样上限。
- `sensor_msgs/LaserScan`：XY 平面扫描，range_min / range_max、有限值过滤，显示颜色、点大小和不透明度可配置。
- `tf2_msgs/TFMessage` / `tf/tfMessage`，`/tf_static`：父子链组合、逆变换、时间戳插值、静态变换、Time(0) 最新共同时间、固定坐标系切换。缺失 TF 时隐藏该数据并提示，不错误地显示在原点。
- `nav_msgs/OccupancyGrid`：未知/空闲/占用灰度，分辨率与 origin 的平移/旋转。
- `nav_msgs/Path`：最多 5000 姿态，逐姿态 frame/time 解析。
- `nav_msgs/Odometry` / `geometry_msgs/PoseStamped`：位置、朝向箭头与坐标轴。未实现协方差显示或速度图。
- Marker / MarkerArray：ADD/MODIFY、DELETE、DELETEALL，namespace/id 替换，frame_locked，有限 lifetime；ARROW、CUBE、SPHERE、CYLINDER、LINE_STRIP、LINE_LIST、CUBE_LIST、SPHERE_LIST、POINTS、TEXT_VIEW_FACING、TRIANGLE_LIST。
- 未锁定 Marker / 有时间戳的一次性显示在首次成功 TF 后保留变换，避免缓存过期后凭空消失；frame_locked Marker 每帧使用最新变换。
- 原始 Image：rgb8 / bgr8 / rgba8 / bgra8 / mono8 / mono16，row step 与大小端。CompressedImage：JPEG / PNG。图像面板显示一个启用的图像流，关闭后停止解码但可单独保留订阅。
- 任意完整 ROS1 schema 的通用消息检查器：64 位整数保留 bigint，数组预览限前 16 项、文本输出限长。
- 旋转、平移、双指缩放、单独缩放按钮、俯视、复位、跟随 frame、TF 坐标轴、点云采样上限。
- 明确标注的离线演示：所有 TF、移动机器人、地图、点云、路径、Marker、图像均为确定性生成数据。连接失败绝不自动进入演示。

## 有意限制 / 未实现

- 不支持 URDF RobotModel、MESH_RESOURCE / package:// 资源、材质/网格加载、RViz 插件、InteractiveMarker、测量、导航目标发布、机器人控制、ROS2、rosbag / MCAP 文件回放。
- LaserScan 不按每束时间做运动去畸变；PointCloud2 不做 voxel 滤波或每点时间去畸变，采用索引等距降采样。packed rgba 的 alpha 不使用。
- Marker 线宽受 WebGL 原生线宽限制，逐顶点 alpha 未实现，Arrow 外观为近似；图像并非基于 CameraInfo 投影到 3D。Marker lifetime 使用本机单调时钟，未按模拟时钟暂停/倍速缩放。
- mono16 按完整 0–65535 范围映射到灰度，不是自动曝光深度图；不支持 16UC1 / 32FC1 / Bayer / YUV / compressedDepth。
- 动态 TF 不外推；非常晚的消息超出缓存范围会提示缺失 TF。收到协议 Time 回退时清空动态 TF 与显示，保留静态 TF；桥没有发送 Time 消息时无法可靠识别所有模拟时钟重置。
- Path 中任何姿态缺 TF 时隐藏整条路径，不把断开的点错误连线。
- UI 内跟随默认 `base_link`，在帮助面板可以更改；没有此 frame 时不会伪造机器人位置。
- 未实现 TLS 自签名证书绕过、凭据输入、认证头配置。URL 禁止 user:password。`ws://` 只用于可信网络，生产跨网连接应使用正确 TLS / VPN / bridge 访问限制。
- 这是验证中的原型，未经过真实机器人安全验证或物理 7 英寸 Android 性能测量。不能用于安全关键决策或控制。

## 性能与资源边界

- 渲染目标约 30 FPS（不保证设备实测），像素比最高 1.6，普通显示消息约 15 Hz 解码合并。
- TF 与 Marker 动作不合并，避免丢静态分片或 DELETE 操作。点云每帧可选 2万 / 6万 / 12万点，默认6万；LaserScan 默认最多6万点。
- 最大256个广告话题、同时32个订阅。首次连接仅 TF 自动启用，其余需要手动选择；后续恢复该服务器已保存的显式选择。
- 原始消息最大32MiB，待解码总量64MiB，检查器最新消息缓存总量32MiB。图像解码一次仅1个任务，另保留1个最新待处理帧，重连/关闭后结果失效。
- TF 最多512个 child、每个180样本 / 最近10秒，frame 名最大256字符，每个输入最多处理2048个变换。
- Marker 最多1000个，累计约30万展开顶点，最多64个文本纹理。列表每条最多3000实例、点/线/三角输入最多2万点。地图最多4M单元，原始图像最多16M像素，压缩图像16MiB / 解码后8M像素。
- Schema 及解析的嵌套、对象数、值数、字符串长度、数组长度均有限制，畸形消息 fail fast。
- 替换/删除显示时释放 Three geometry/material/texture；不累积每帧点云或无界历史。

## Android 外壳约定

- 使用本地 HTTPS 资源源且允许到经用户明确输入的 ws/wss 地址连接。
- CSP 需要 `connect-src ws: wss:`，`img-src 'self' blob: data:`；不需要 unsafe-eval、外部脚本或 worker。
- 监听 `window` 的 `CustomEvent('androidlifecycle', { detail: { state: 'pause'|'resume' }})`：后台断开，前台恢复此前用户启用的 live 连接。也监听 document.visibilitychange。
- 监听可取消 `Event('androidback', {cancelable:true})`：优先关闭打开的 dialog 或 drawer 并 preventDefault；没有 UI overlay 时由 native 正常退出。
- 窗口旋转仅调整 canvas 大小。使用系统键盘输入连接地址。

## 测试与诊断

`npm test` 覆盖二进制 envelope、真正 ROS1 schema 解析、混合 field datatype/大小端/row padding、TF 时间链、图像步长、畸形消息、订阅/取消/重连、只读操作和 Marker 生命周期。`scene-review.test.ts` 使用真实 Three 对象、替代 GPU 和控制器，不能替代实际 GPU/手机测试。

`window.viewerDiagnostics()` 只返回状态、话题计数、TF frame、图层信息与 GPU 资源统计，不提供发布/服务调用能力。QA 工具在项目 `../qa/`，其独立 Python 二进制 fixture 可对照该查看器。测试涉及 fixture 时通过实际存在的项目路径读取。

第三方许可证与版权见 `public/THIRD_PARTY_NOTICES.txt`，构建后随 `dist/` 分发。

## v0.1.1 连接诊断

顶部「诊断」按钮打开可滚动的手机横屏面板，默认连接输入为文档占位地址 `ws://192.0.2.1:8765`（请换成自己的机器人地址），不会自动连接或自动进入演示。

- WebGL 2 不可用时仍显示独立的连接 / 诊断入口，可检测 WebSocket、查看 serverInfo / advertise、运行原生 TCP / Ping、复制报告；该模式不会自动订阅 ROS 数据，也不会伪造三维画面。
- 单独显示 URL 格式校验、连接尝试、WebSocket 握手成功、协商子协议、serverInfo 名称/能力、首次 advertise、广告/可解析/已订阅数量、首帧二进制、最后任意消息与最后订阅数据时间。
- 「尚无 advertise」「收到空列表」「没有可解析的 ROS1 schema」「已订阅但还没数据」分别提示；这些状态不会被误判为断网。10 秒无订阅数据仅作未更新提醒，静态或低频话题可能正常。
- 保留最多 160 条 UTC 时间线，每条细节最多 1200 字符。断开、重试或清空场景不会清空历史；记录浏览器实际提供的 close code / reason / wasClean 和重试退避。
- 「立即重试」使用连接窗口当前输入；「停止重试 / 断开」取消待执行重连。「清空日志」仅清时间线，保留连接摘要。
- 「复制诊断」复制脱敏文本；「导出文本」显示可长按复制的完整文本。普通浏览器可以下载 `.txt`；Android WebView 若没有下载提示，应使用复制文本，不代表文件已保存。
- 隐藏 URL 用户信息和全部查询参数值，并隐藏常见 token/password/Authorization 文本。报告仍含主机地址、服务端名称和设备 UA，分享前应检查。URL 带查询参数时不保存到本地偏好。
- WebSocket API 不提供底层 DNS/TCP/TLS 失败原因，也不提供 HTTP 握手状态码。`error` 或 close 1006 不能直接解释为端口拒绝、证书错误或网络故障。
- v0.1.1 Android 外壳提供「检测 TCP / Ping」：只在用户点击时检查当前输入的那个主机/端口，回传 DNS/TCP/ICMP 结果、系统/WebView 版本与脱敏 WebView 错误类别。TCP 可达不代表 WebSocket/Foxglove 握手成功；Ping 失败或系统无 Ping 能力不代表 TCP 不通。普通浏览器无法进行原生 TCP/ICMP 检测。
- `window.viewerDiagnostics()` 增加 `network`（连接阶段摘要）、`diagnosticLog`（有界脱敏时间线）与 `networkProbe`（最近一次原生检测结果）；不包含原始 ROS 消息正文，不增加任何发布或服务调用接口。

原生桥接约定：`window.AndroidDiagnostics.requestNetworkDiagnostics(url, requestId)` 必须由 `#network-probe` 的真实用户点击同步调用，URL 必须与 `#url` 当前 trim 后文本完全一致。监听 `androidnetworkdiagnostics` 的 `CustomEvent.detail`，按 requestId 关联，忽略过期回复。`androiddiagnosticsready` 表示受限原生通道可用；应用进入后台取消未完成检测的界面状态。

## v0.2.0 话题与图层设置

详见 [显示设置说明](../docs/DISPLAY_SETTINGS_0.2.0.zh-CN.md)。图层抽屉提供话题名/类型搜索和分类过滤，右侧 ⚙ 打开独立设置。搜索不会订阅话题，设置不会改变订阅，取消勾选发送 unsubscribe。首次连接只自动订阅 TF，其他话题由用户选择；最多 32 个并发订阅，包括 TF。

设置按规范化服务器 URL、话题名和 ROS 类型保存，不使用易变的 channel ID。最多 12 个服务器、每个 256 个话题，序列化内容最多 1,500,000 字符；超限逐出最久未选择的服务器，保留当前配置。URL 带查询参数/凭据/片段时不保存该服务器配置，避免落盘凭据。演示数据使用独立配置。设置损坏、版本未知、存储被禁或写满时保留安全默认/会话行为。

字段缺失或无效的显式 RGB/强度模式退回固定颜色，并在图层状态提示。RGB 仅接收 count=1 的 INT32/UINT32/FLOAT32 packed 字段；packed float 采用位重解释，不把浮点值转为颜色。强度与高度按保留的有限样本范围逐帧归一化，恒定值显示中间色。部分非有限强度用备用色。高度为消息坐标系 Z，并非转换后固定坐标系高度。

点大小为世界坐标米（0.01–0.5），随相机距离缩放；不透明度 0–1；点云预算 2万/6万/12万，底层输入验证范围 1000–120000。每帧替换释放 geometry/material。改变外观不重订阅；颜色模式/采样预算改变时重解码有界最新帧，保留其已解析 TF。若最新消息已被 32 MiB 缓存逐出，清除旧几何并明确等待新消息，不伪称旧图已应用设置。

新增 `main.test.ts` 小型 DOM/event harness 测试真实主模块的搜索、筛选、订阅、配置、关闭/Back 和频道重用路径。它不实现浏览器布局，也不代表真机或 GPU 验证。
