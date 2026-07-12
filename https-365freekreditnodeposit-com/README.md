# Free Credit Landing Page

这是一个可以上传到 GitHub、再部署到 Railway 的前台 + 后台网页项目。

## 包含内容

- 前台页面：`outputs/index.html`
- 后台页面：`outputs/admin.html`
- 默认资料：`outputs/assets/offers-data.js`
- 图片资源：`outputs/assets/slot-hero.png`
- 本地预览服务器：`work/static-server.mjs`
- 安全后台服务器：`work/secure-server.mjs`
- Railway / Node 启动设置：`package.json`
- 环境变量模板：`.env.example`

## 本地启动

先安装 Node.js 20 或以上版本，然后在项目文件夹运行：

```bash
npm start
```

打开：

- 前台：`http://127.0.0.1:4173/`
- 后台：`http://127.0.0.1:4173/admin.html`

后台会先进入登录页。

## 上传 GitHub

可以上传这些文件和文件夹：

```text
.gitignore
.env.example
README.md
package.json
outputs/
work/
```

不要上传：

```text
.env
node_modules/
work/*.log
work/*.err
```

`.env` 里面会放后台密码、Cloudflare Token 等秘密资料，只能留在自己电脑或 Railway Environment Variables。

## Railway 环境变量

部署到 Railway 后，请在 Railway 的 Variables / Environment Variables 加入：

```text
ADMIN_USER=你的后台账号
ADMIN_PASSWORD=你的后台密码
SESSION_SECRET=一串很长的随机文字
CLOUDFLARE_API_TOKEN=你的 Cloudflare API Token
```

可选：

```text
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_ZONE_NAME=
```

如果不填 `CLOUDFLARE_ZONE_ID`，系统会尝试根据你输入的 domain 自动寻找 Cloudflare zone。

## 后台功能

后台可以修改：

- Logo
- 网站名字
- 前台字眼
- 英文 / 马来文 / 华语内容
- 公司资料
- 公司 Logo
- 完整注册链接
- 星星评分，最多 5 粒
- Telegram / Facebook / WhatsApp 等 Join Our 资料
- 背景颜色、按钮颜色、边框颜色、文字颜色
- Domain 管理
- Cloudflare DNS 自动连接

## Domain 自动连接说明

买 domain 后，把 domain 加进后台的 `Domain 网页管理`，填写 Target Server，然后点击 `自动连接 Cloudflare`。

注意：

- 自动连接需要正式部署在 Railway 或安全服务器。
- `CLOUDFLARE_API_TOKEN` 必须放在服务器环境变量。
- Token 不会保存到网页，也不会进入浏览器。
- GitHub 只保存代码，不保存密码和 Token。

## 重要安全提醒

- 不要把 `.env` 上传 GitHub。
- 不要把 Cloudflare API Token 写在后台网页里。
- 后台账号密码只放 `.env` 或 Railway Environment Variables。
- 部署后建议使用 Cloudflare Proxy / WAF 保护 domain。
