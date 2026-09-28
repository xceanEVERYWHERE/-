智慧树助手一体版 2.1.2，将原速连续播放、DeepSeek 随堂题辅助和共享课输入整合为一个 Chrome 扩展。

## 安装

1. 使用桌面版 Google Chrome 125 或更新版本。
2. 下载本页 Assets 中的 `zhihuishu-assistant-v2.1.2.zip`，解压到长期保留的位置。
3. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载包含 `manifest.json` 的 `zhihuishu-unified` 文件夹。
4. 自动答题目前只支持 DeepSeek 官方 API，填写自己的 API Key；共享课需点击扩展图标显示 ON，再点击面板“开始”。

完整使用说明见 [README](https://github.com/xceanEVERYWHERE/-#readme)。

## 本版本

- 保持 1 倍速，完整播放结束后等待 5 秒再切课；章节测试和考试自行完成。
- 修复首次配置密钥被无效运行记录阻断的问题。
- 页面加载中自动等待初始化，失败后可重试启动。
- README 整理了运行条件、安装、配置、使用和常见问题。

已完成离线功能检查；网站页面变化或未适配题型仍可能需要手动处理。

