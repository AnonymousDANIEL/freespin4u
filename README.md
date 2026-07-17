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
DATA_DIR=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_ZONE_NAME=
```

如果不填 `CLOUDFLARE_ZONE_ID`，系统会尝试根据你输入的 domain 自动寻找 Cloudflare zone。

如果之后 Railway 有加 Volume，可以把 `DATA_DIR` 设成 Volume 的路径，例如 `/data`，后台资料会保存到 Volume 里面。

## 后台功能

后台可以修改：

- Logo
- 背景图上传会自动裁切、居中对焦和压缩
- Logo 上传会保留完整比例，不会裁掉左右或上下
- 前台公司 Logo 使用较大的横向展示位，方便客人一眼看到公司
- 前台公司卡片不显示 Best / Hot / Top 字眼，只显示 Logo 和星星评分
- Logo 外框背景和 Logo 图片底色都可以在后台颜色设置里更改
- 每家公司可以开关公司名下面小字，并限制下面卖点文案显示 0-3 行
- 后台颜色设置已拆成基础网页、Logo / 公司卡片、按钮、底部社群和 Live Transaction 分组
- GIF 动图上传会保留动画，并显示图片大小
- 网站名字
- 前台字眼
- 英文 / 马来文 / 华语内容
- 公司资料
- 公司 Logo
- 完整注册链接
- 星星评分支持 0.1 小数，例如 1.1 / 4.2 / 4.9，最多 5 粒
- Live Transaction，每家公司可设置不同 live 网页链接、显示 2 或 3 行、备用资料
- Live Transaction 总开关，以及 Live 表格颜色设置
- Telegram / Facebook / WhatsApp 等 Join Our 资料
- 背景颜色、按钮颜色、边框颜色、文字颜色
- Domain 管理
- Cloudflare DNS 自动连接
- 服务器保存资料，后台修改后前台会读取同一份公司 / Live / 颜色资料
- 如果刷新又看到旧 record，去后台点击 `清空所有记录并同步`，它会同时把浏览器和服务器的公司 / 社群 / Domain 列表同步成空列表
- 前台刷新时会先确认已保存语言，再显示页面，避免英文 / 马来文页面先闪一下华语

## Domain 自动连接说明

买 domain 后，把 domain 加进后台的 `Domain 网页管理`，填写 Target Server，然后点击 `自动连接 Cloudflare`。

注意：

- 自动连接需要正式部署在 Railway 或安全服务器。
- `CLOUDFLARE_API_TOKEN` 必须放在服务器环境变量。
- Token 不会保存到网页，也不会进入浏览器。
- GitHub 只保存代码，不保存密码和 Token。

## Live Transaction 说明

后台每家公司都可以设置：

- 是否显示 Live Transaction
- Live 网页连接
- 显示 2 或 3 行
- 备用 Live 资料

系统会先尝试从 Live 网页连接抓公开文字资料。如果对方网页不允许抓取、需要登录、或资料是特殊脚本加载，就会显示后台填写的备用资料。

后台保存公司、Live Transaction、颜色和社群入口后，会同步到服务器。前台会优先读取服务器资料，所以同一个 domain 下会一起更新。

## 重要安全提醒

- 不要把 `.env` 上传 GitHub。
- 不要把 Cloudflare API Token 写在后台网页里。
- 后台账号密码只放 `.env` 或 Railway Environment Variables。
- 部署后建议使用 Cloudflare Proxy / WAF 保护 domain。
