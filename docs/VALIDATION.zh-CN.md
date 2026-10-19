# 公开源码验证记录

日期：2026-10-19。范围：v0.2.0 话题选择与独立图层设置，包含此前连接诊断回归。

## 本次实际通过

- `npm test`：7 个测试文件、179 项测试通过。
- `npm run build`：TypeScript 类型检查与 Vite 生产构建通过。
- 新增显式颜色模式、混合字段/大小端、无效颜色字段回退、非有限强度、独立材质/点数预算、已解析 TF 保留、频道 ID 重用释放、偏好容量/损坏/隔离与重新读取测试。
- `main.test.ts` 小型 DOM/event harness：测试实际主模块的搜索、分类、选择、设置、输入验证、频道替换、关闭/Back、未缓存点云更新状态。该 harness 不模拟真实浏览器布局或 GPU。
- 独立复核发现并修复：序列化配置超限导致下次启动丢失；原始点云缓存已逐出后修改颜色模式/预算却仍显示旧帧。修复后重新通过全部测试与构建。
- `bash scripts/android-test.sh`：41 项 Java 诊断检查、14 项 JavaScript 原生桥接检查通过。
- Android SDK 35 / build-tools 35.0.0 APK 构建；签名校验、ZIP 对齐、manifest、DEX、ZIP 完整性及打包资源字节一致性检查通过。
- Android `NewApi,InlinedApi,MissingPermission` 定向 lint 通过。此项目没有 Gradle 构建或完整 Android lint 流水线。
- `python3 qa/test_fixture_protocol.py`：6 项合成消息与真实本地 WebSocket 生命周期测试通过。
- `python3 qa/test_diagnostic_protocol.py`：7 项合成协议场景测试通过。
- `node qa/test_connection_diagnostics.cjs`：12 项连接状态、重连与信息隐藏回归通过。
- `node qa/test_schema_decoder.cjs`：8 个合成 ROS1 话题解析交叉检查通过。
- Shell 脚本语法与 Python 编译检查通过。

测试环境：Linux x86_64，Node.js 24，Python 3.12，OpenJDK 21。

## 验证限制

- 未完成此次浏览器视觉验收：运行环境的本地测试服务器与浏览器无法互通，独立 Chromium 启动也受运行环境限制。没有把 DOM/event harness 或设计尺寸当作实际屏幕验证。
- 未在物理 Android 设备上测试安装、WebView/GPU、触控、系统 Ping、VPN、后台恢复、发热或续航。
- 未连接真实 ROS1 主机或机器人；合成测试不代表真实设备兼容性。
- 此次单独交付的 v0.2.0 测试 APK 使用新的调试签名。已验证与旧 v0.1.1 签名不同，不能覆盖安装旧版；卸载旧版会清除本地偏好。没有声称兼容覆盖更新。

本仓库不附带旧版 APK、签名私钥、SDK、依赖目录或内部调试日志。源码中的连接示例使用文档保留地址 `192.0.2.1`，需要换成自己的目标地址。构建产物保留在本地交付路径；实际 APK 清单和各资源 SHA-256 可通过构建报告对照当前 `web/dist`。

后续设备验证请使用 [验收清单](ACCEPTANCE.zh-CN.md)，记录实际设备、软件版本、数据负载与观察结果。
