/**
 * 扩展配置键
 */
export const CONFIG_KEYS = {
  SCRIPT_PATH: 'cursorAndroidLogcat.scriptPath',
  DEBUG: 'cursorAndroidLogcat.debug',
  ADB_PATH: 'cursorAndroidLogcat.adbPath',
} as const;

/**
 * 时间相关常量
 */
export const TIMING = {
  /** 追加日志刷新间隔（毫秒） */
  APPEND_FLUSH_INTERVAL_MS: 33,
  /** 追加日志大小阈值（字节） */
  APPEND_SIZE_THRESHOLD: 64 * 1024,
  /** 设备列表刷新延迟（毫秒） */
  DEVICE_REFRESH_DELAY_MS: 150,
  /** 设备刷新重试延迟列表（毫秒） */
  DEVICE_RETRY_DELAYS: [300, 800, 1500, 2500, 4000],
  /** 设备等待超时列表（毫秒） */
  DEVICE_WAIT_TIMEOUTS: [15000, 30000, 60000],
  /** PID 映射重建延迟（毫秒） */
  PID_MAP_REBUILD_DELAY_MS: 50,
  /** PID 映射刷新间隔（毫秒） */
  PID_MAP_REFRESH_INTERVAL_MS: 1000,
} as const;

/**
 * 日志缓冲区类型
 */
export const LOG_BUFFERS = {
  MAIN: 'main',
  SYSTEM: 'system',
  EVENTS: 'events',
  RADIO: 'radio',
  ALL: 'all',
} as const;

/**
 * 日志级别
 */
export const LOG_LEVELS = {
  VERBOSE: 'V',
  DEBUG: 'D',
  INFO: 'I',
  WARNING: 'W',
  ERROR: 'E',
  FATAL: 'F',
} as const;

/**
 * 设备状态
 */
export const DEVICE_STATUS = {
  DEVICE: 'device',
  OFFLINE: 'offline',
  UNAUTHORIZED: 'unauthorized',
  UNKNOWN: 'unknown',
} as const;

/**
 * 默认值
 */
export const DEFAULTS = {
  TAG: '*',
  LEVEL: 'D',
  BUFFER: 'main',
  MAX_HISTORY_LINES: 5000,
  MAX_DUMP_HISTORY_LINES: 10000,
} as const;

/**
 * WebView 消息类型
 */
export const MESSAGE_TYPES = {
  READY: 'ready',
  STATUS: 'status',
  APPEND: 'append',
  DEVICES: 'devices',
  START: 'start',
  STOP: 'stop',
  PAUSE: 'pause',
  RESTART: 'restart',
  CLEAR: 'clear',
  EXPORT_LOGS: 'exportLogs',
  IMPORT_LOGS: 'importLogs',
  IMPORT_MODE: 'importMode',
  IMPORT_DUMP: 'importDump',
  REQUEST_HISTORY: 'requestHistory',
  HISTORY_DUMP: 'historyDump',
  REFRESH_DEVICES: 'refreshDevices',
  SELECT_DEVICE: 'selectDevice',
  PID_MAP: 'pidMap',
  PID_MISS: 'pidMiss',
  CONFIG: 'config',
  DEBUG: 'debug',
  VISIBLE: 'visible',
} as const;

/**
 * 状态消息文本
 */
export const STATUS_MESSAGES = {
  DEVICE_OFFLINE_WAITING: '设备离线，等待设备上线…',
  DEVICE_ONLINE_STARTING: '设备已上线，正在启动…',
  DEVICE_RECOVERED_STARTING: '设备已恢复在线，正在自动启动…',
  DEVICE_UNAUTHORIZED: '设备未授权，请在手机上允许 USB 调试',
  DEVICE_NOT_DETECTED: '未检测到设备，自动启动跳过',
  RECONNECT_TIMEOUT: '重连超时，请稍后重试或检查设备连接',
  REFRESHING_DEVICES: '刷新设备...',
  SELECT_DEVICE_FIRST: '请先选择设备',
  RESTARTING_LOGCAT: '正在重启 logcat…',
  RESTARTED: '已重启',
  PREPARING_EXPORT: '正在准备导出...',
  EXPORT_CANCELLED: '已取消导出',
  EXPORT_FAILED: '导出失败',
  IMPORT_CANCELLED: '已取消导入',
  IMPORT_FAILED: '导入失败',
  LOADING_HISTORY: '正在加载历史日志...',
  HISTORY_LOADED: '历史日志已加载',
  HISTORY_LOAD_FAILED: '加载历史日志失败',
  CLEARED: '已清空（仅UI与缓冲）',
  ALREADY_RUNNING: '已在运行中',
  PAUSED: '已暂停',
  RESUMED: '已恢复',
  STOPPED: '已停止',
  ENTERED_IMPORT_MODE: '已进入导入模式',
} as const;

/**
 * 文件相关常量
 */
export const FILES = {
  DEFAULT_EXPORT_FILENAME: 'AndroidLog.txt',
  SCRIPT_SUBPATH: ['scripts', 'logcat_android', 'cli_logcat.sh'],
} as const;

/**
 * 正则表达式
 */
export const REGEX = {
  /** 匹配设备列表标题行 */
  DEVICES_HEADER: /^List of devices attached/i,
  /** 匹配守护进程消息 */
  DAEMON_MESSAGE: /\* daemon /i,
  /** 匹配设备状态 */
  DEVICE_STATUS: /^(device|offline|unauthorized|unknown)$/,
  /** 匹配设备型号 */
  DEVICE_MODEL: /model:(\S+)/,
} as const;

