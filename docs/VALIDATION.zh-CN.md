# 公开源码验证记录

日期：2026-10-17。范围：v0.1.1 公开源码，包含连接诊断。

## 本次实际通过

- 使用锁文件安装 Web 依赖（`npm ci --ignore-scripts`）。
- `npm test`：5 个测试文件、128 项测试通过。
- `npm run build`：TypeScript 类型检查与 Vite 生产构建通过。
- `bash scripts/android-test.sh`：41 项 Java 诊断检查、14 项 JavaScript 原生桥接检查通过。
- `python qa/test_fixture_protocol.py`：6 项合成消息与真实本地 WebSocket 生命周期测试通过。
- `python qa/test_diagnostic_protocol.py`：7 项合成协议场景测试通过。
- `node qa/test_connection_diagnostics.cjs`：12 项连接状态、重连与信息隐藏回归通过。
- `node qa/test_schema_decoder.cjs`：8 个合成 ROS1 话题解析交叉检查通过。
- Shell 脚本语法与 Python 编译检查通过。

测试环境：Linux x86_64，Node.js 24，Python 3.12，OpenJDK 21。

## 未在本次复核中执行

- 当前验证环境没有 Android SDK/build-tools，未重新生成或验证 APK，未运行 Android SDK lint。
- 未重新执行桌面浏览器视觉验收。
- 未在物理 Android 设备上测试安装、WebView/GPU、触控、系统 Ping、VPN、后台恢复、发热或续航。
- 未连接真实 ROS1 主机或机器人；合成测试不代表真实设备兼容性。

本仓库不附带旧版 APK、旧构建哈希或内部调试日志。源码中的连接示例使用文档保留地址 `192.0.2.1`，需要换成自己的目标地址。签名密钥、工具链、依赖目录与测试产物均排除在版本控制外。

后续设备验证请使用 [验收清单](ACCEPTANCE.zh-CN.md)，记录实际设备、软件版本、数据负载与观察结果。
