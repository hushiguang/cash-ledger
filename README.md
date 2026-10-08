# 轻账单 · LEDGER

自托管的个人 / 家庭记账本。支持多账本、共享账本免登录补账、账单导入与自动归类、定期账单、查重。

- 后端：Node 22 + Express + `node:sqlite`
- 前端：React 18 + Vite
- 数据：单个 SQLite 文件，备份就是拷文件

## 功能

| 模块 | 说明 |
| --- | --- |
| 总览 | 结余、收支、分类排行 |
| 日历 | 按天看账单 |
| 账单 | 筛选、编辑、批量操作，导出 CSV / Excel |
| 定期 | 房租、工资等周期性账单，到期自动生成 |
| 导入 | 微信 / 支付宝 / 京东 / 钱迹 / 招商银行流水，CSV、Excel、PDF |
| 账户 | 账户归并、别名、类型（现金/微信/支付宝/银行卡…） |
| 分类 | 两级分类树，支出 12 大类、收入 7 大类 |
| 查重 | 微信/支付宝绑卡导致的同一笔双记 |
| 账本 | 个人账本、出游共享、家庭账本；成员协作 |
| 分享 | 生成免登录链接，同伴打开就能补账（不用注册） |

## 本地开发

需要 Node 22.5+（用到 `node:sqlite`）。

```bash
# 后端，默认 8080，数据在 server/data/ledger.db
cd server && npm install && npm run dev

# 前端，5173，已配置 /api 代理到 8080
cd web && npm install && npm run dev
```

打开 http://localhost:5173，注册第一个账号会自动成为管理员。

## Docker 部署

`docker-compose.yml` 是多阶段构建镜像：前端打包进镜像，数据挂在 `./data`。

```bash
cp .env.example .env      # 按需修改
docker compose up -d --build
```

访问 `http://<主机IP>:8080`。注册完第一个管理员后，建议把 `ALLOW_REGISTER` 改成 `false` 重启。

### 带现有数据部署

用导出脚本把本地开发库做成一致性快照（不用停本地服务，也不会带 WAL）：

```bash
node --experimental-sqlite scripts/export-db.mjs
```

产物是 `./data/ledger.db`，正好是 compose 挂载的目录。覆盖前会自动备份旧库，也可用 `SRC_DB=… OUT_DIR=…` 指定路径。

## 环境变量

见 `.env.example`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 自动生成 | 留空会写入 `data/jwt.secret`；换值会让所有人重新登录 |
| `ALLOW_REGISTER` | `true` | 是否开放注册 |
| `IMAGE_HOST_URL` | EasyImages2.0 地址 | 账单图片图床 |
| `IMAGE_HOST_TOKEN` | — | 图床 token |
| `PORT` | `8080` | 服务端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `DATA_DIR` | `/data` | 容器内数据目录 |

## 导入与自动归类

导入时分类按三层兜底，基本不需要手工配置：

1. **账单自带的分类列** → 命中别名表就落到主分类  
   已覆盖支付宝、微信、京东、钱迹的常用分类名，见 `server/src/taxonomy.js` 的 `EXTERNAL_CATEGORY`。  
   例：`餐饮美食 → 餐饮`、`鞋服箱包 → 购物/服饰鞋包`、`手机通讯 → 通讯/话费`。
2. **没有分类列或没命中** → 关键词猜  
   `server/src/importers.js` 的 `KEYWORDS`：美团/饿了么→餐饮，滴滴/地铁/加油→交通，淘宝/京东/盒马→购物，房租/水电/燃气→居住，医院/药店→医疗，话费→通讯，红包→人情。
3. **都猜不到** → 归到「其他」，之后在账单页手改。

导入格式：`auto` 会自动识别，也可在导入页手动选 `wechat` / `alipay` / `jd` / `qianji` / `cmb` / `custom`，支持 `.csv .xlsx .xls .txt .pdf`（PDF 目前是招商银行流水）。GBK 编码的 CSV 会自动转码。

账户名也会自动归一化：去掉「微信-」渠道前缀、`额度&红包` 这类组合后缀、银行全称统一（中国工商银行 → 工商银行）、`花呗分期 → 花呗`。自己的卡号映射写在 `server/src/taxonomy.js` 的 `ACCOUNT_MERGE`。

想加规则就改这两个文件（改完要重新 build 镜像）。也可以在「分类」页手工加分类、「账户」页加别名或归并，这些存在数据库里，跟着数据走。

## 账本与分享

- **个人账本**：只有自己能看，不能分享。
- **出游共享 / 家庭账本**：可加成员，成员按权限记账。
- **免登录链接**：管理者在「账本」页开启分享，生成 `/share/<token>`。拿到链接的人不用注册，填名字就能补账并上传图片。关闭分享后旧链接失效，重新开启会沿用原来的 token。

## 数据与备份

- 数据库：`DATA_DIR/ledger.db`，SQLite WAL 模式。
- 备份：直接拷 `ledger.db`（迁移脚本用 `VACUUM INTO` 生成一致快照，不需要停服务）。
- 结构变更时会自动做一次备份：`ledger.db.bak-<时间戳>`。

## 目录结构

```
server/          后端（Express + SQLite）
  src/index.js      路由与接口
  src/ledger.js     账单读写、账户/分类解析
  src/importers.js  各平台账单解析与归类
  src/taxonomy.js   分类树、外部分类别名、账户归并表
  src/books.js      账本、成员、分享 token
  src/recurring.js  定期账单
  src/duplicates.js 查重
web/             前端（React + Vite）
  src/App.jsx       全部页面
  src/styles.css    样式
scripts/export-db.mjs  本地库 → Docker 数据目录
```
