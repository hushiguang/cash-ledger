// 集中配置：部署期可调项走环境变量（见仓库根目录 deploy.conf.example），
// 其余是有合理默认值的常量。改这里就能调容量/安全/阈值，不用翻各个模块。
import path from 'node:path';

function boolEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0';
}

function numEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, 'ledger.db');

export const config = {
  // 运行环境
  runtime: {
    port: numEnv(process.env.PORT, 8080),
    host: process.env.HOST || '0.0.0.0',
    dataDir,
    databasePath,
    // Docker bridge 网络没有 IPv6，图床只解析到 IPv6 时会 ENETUNREACH，优先 IPv4
    dnsResultOrder: 'ipv4first',
  },

  // 认证与安全
  auth: {
    // 不配就写文件随机生成（auth.js 负责落盘）
    jwtSecret: process.env.JWT_SECRET || null,
    jwtExpiry: process.env.JWT_EXPIRY || '14d',
    bcryptRounds: numEnv(process.env.BCRYPT_ROUNDS, 10),
    allowRegister: boolEnv(process.env.ALLOW_REGISTER, true),
  },

  // HTTP 层
  http: {
    jsonBodyLimit: process.env.JSON_BODY_LIMIT || '20mb',
    // true = 允许所有来源（当前行为）；要限制就填逗号分隔的域名列表
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()) : true,
  },

  // 上传
  upload: {
    multipartMaxBytes: numEnv(process.env.UPLOAD_MAX_BYTES, 30 * 1024 * 1024),
    imageMaxBytes: numEnv(process.env.IMAGE_MAX_BYTES, 12 * 1024 * 1024),
  },

  // 图床与图片代理
  imageProxy: {
    url: process.env.IMAGE_HOST_URL || '',
    token: process.env.IMAGE_HOST_TOKEN || '',
    // 允许回源的主机白名单（逗号分隔）；不填则仅放行 IMAGE_HOST_URL 的主机
    allowHosts: (process.env.IMAGE_HOST_ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // /api/image 代理缓存时长（秒）
    cacheTtlSeconds: numEnv(process.env.IMAGE_PROXY_CACHE_TTL, 86400),
  },

  // 分页与查询上限
  pagination: {
    transactionsDefault: numEnv(process.env.TX_LIMIT, 500),
    transactionsMax: numEnv(process.env.TX_LIMIT_MAX, 5000),
    searchDefault: 20,
    searchMax: 50,
    // 关键词搜索最多拆几个词（AND）
    keywordMaxWords: 6,
  },

  // 定时任务
  scheduler: {
    intervalMs: numEnv(process.env.SCHEDULER_INTERVAL_MS, 60 * 1000),
  },

  // 查重阈值（duplicates.js 使用）
  duplicates: {
    // 同账户两笔要报重复的最低分（同额+同时刻+商户名一致才够硬）
    sameAccountMinScore: numEnv(process.env.DUP_SAME_ACCOUNT_MIN_SCORE, 75),
    // 一组最多合并多少条，避免一次误删一大片
    groupMaxSize: numEnv(process.env.DUP_GROUP_MAX_SIZE, 12),
    // 查重默认时间窗口（天）
    defaultWindowDays: numEnv(process.env.DUP_WINDOW_DAYS, 1),
    // 评分权重
    scores: {
      baseline: 40, // 同额 + 分属不同账户
      sameTime: 30, // 同一时刻
      sameDay: 20, // 同一天
      gap: 8, // 跨天
      merchantExact: 22, // 商户名包含
      merchantNear: 10, // 商户名相近（最长公共片段 >= 2）
      channel: 20, // 渠道互证（微信/支付宝）
      order: 25, // 商户单号相同
      largeAmount: 5, // 金额 >= 50 元，偶然撞号概率低
    },
  },

  // 定期账单默认值
  recurring: {
    defaultTime: process.env.RECURRING_DEFAULT_TIME || '09:00',
  },
};
