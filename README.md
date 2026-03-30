# fx-workers

感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬 感谢zj大佬

Cloudflare Worker（VLESS + 订阅 + 面板）。

## 功能

- WebSocket VLESS 转发（含并发连接与分段发送逻辑）
- `proxyip` 优先级：`URL 参数 > 面板自定义 > 分区域 > 兜底`
- `/sub` 自适应订阅：
  - Clash/Mihomo/Meta UA 返回 YAML（含自动选择与基础分流）
  - 其它客户端返回 Base64
- `/panel` 极简黑白面板：
  - 首次访问需初始化密码
  - 支持设置 UUID、自定义 ProxyIP
  - UUID 一键随机生成

## 路由

- `GET /panel`：配置面板
- `POST /panel/init`：首次设置密码
- `POST /panel/login`：登录
- `POST /panel/save`：保存 UUID / 自定义 ProxyIP
- `POST /panel/logout`：退出
- `GET /sub?uuid=你的UUID`：自适应订阅

## 部署

### GitHub Actions

本仓库已内置工作流：`.github/workflows/deploy-worker.yml`。

触发方式：

- push 到 `main` 分支自动部署
- 在 GitHub Actions 页面手动点 `Run workflow`

先在仓库 **Settings -> Secrets and variables -> Actions** 新增：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

工作流会自动执行：

1. `node scripts/setup-kv-binding.js CONFIG_KV fxkv`（自动创建/复用 KV 并写入 `wrangler.toml`）
2. `npx wrangler deploy`

## 使用说明

1. 打开 `/panel`
2. 首次先设置密码
3. 登录后填写 UUID（可点“随机”）和自定义 ProxyIP（可空）
4. 保存后复制“自适应订阅”地址使用