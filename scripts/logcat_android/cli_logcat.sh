#!/usr/bin/env bash
set -euo pipefail

SERIAL=""
PACKAGE=""
PID=""
TAG="*"
LEVEL="D"            # V/D/I/W/E/F/S
BUFFER="main"        # main|system|events|radio|crash|all
GREP_REGEX=""
EXCLUDE_REGEX=""
SAVE=false
CLEAR=false
LAUNCH=false
RESTART=false
RAW_FILE=false       # 保存“带 ANSI 颜色”的原始文件
TAIL_LINES=""        # 显示缓冲区尾部 N 行后继续跟随
SINCE_TIME=""        # 从特定时间开始（格式: MM-DD HH:MM:SS.mmm）
OUT_DIR=""
NO_COLOR=false
DURATION=""
FORMAT=""           # 覆盖 logcat -v，默认 color,threadtime,year（或 threadtime,year 当 --no-color）

# 加载模块（不改变行为）
__DIR="$(cd "$(dirname "$0")" && pwd)"
source "${__DIR}/lib/usage.sh"

usage || true

# 统一清理与信号处理
CLEANED_UP=0
cleanup() {
  if [[ "$CLEANED_UP" -eq 1 ]]; then return; fi
  CLEANED_UP=1
  # 杀掉由当前脚本派生的子进程（刷新协程、logcat、tee 等）
  pkill -P $$ 2>/dev/null || true
  # 终止已记录的后台任务
  [[ -n "${PIDMAP_REFRESH_PID-}" ]] && kill "${PIDMAP_REFRESH_PID}" 2>/dev/null || true
  [[ -n "${WATCHDOG_PID-}" ]] && kill "${WATCHDOG_PID}" 2>/dev/null || true
  # 删除临时文件
  [[ -n "${PID_MAP_PATH-}" ]] && rm -f "${PID_MAP_PATH}" 2>/dev/null || true
  # 停止键盘监听并清理暂停状态
  command -v stop_key_listener >/dev/null 2>&1 && stop_key_listener || true
  command -v cleanup_pause_state >/dev/null 2>&1 && cleanup_pause_state || true
}

trap 'echo; echo "已中断 (SIGINT)"; cleanup; exit 130' INT
trap 'echo; echo "已中断 (SIGTERM)"; cleanup; exit 143' TERM
trap 'cleanup' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--serial)   SERIAL="$2"; shift 2 ;;
    -p|--package)  PACKAGE="$2"; shift 2 ;;
    --pid)         PID="$2"; shift 2 ;;
    -t|--tag)      TAG="$2"; shift 2 ;;
    -l|--level)    LEVEL="$2"; shift 2 ;;
    -b|--buffer)   BUFFER="$2"; shift 2 ;;
    -g|--grep)     GREP_REGEX="$2"; shift 2 ;;
    --exclude)     EXCLUDE_REGEX="$2"; shift 2 ;;
    -f|--save)     SAVE=true; shift ;;
    -c|--clear)    CLEAR=true; shift ;;
    --launch)      LAUNCH=true; shift ;;
    --restart)     RESTART=true; shift ;;
    --raw-file)    RAW_FILE=true; shift ;;
    --tail)        TAIL_LINES="$2"; shift 2 ;;
    --since)       SINCE_TIME="$2"; shift 2 ;;
    --out)         OUT_DIR="$2"; shift 2 ;;
    --no-color)    NO_COLOR=true; shift ;;
    --duration)    DURATION="$2"; shift 2 ;;
    --format)      FORMAT="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

# 继续加载其余模块
source "${__DIR}/lib/device.sh"
source "${__DIR}/lib/filters.sh"
source "${__DIR}/lib/pidmap.sh"
source "${__DIR}/lib/runner.sh"
source "${__DIR}/lib/pausable.sh"

# 参数健壮性校验
LEVEL="$(printf '%s' "$LEVEL" | tr '[:lower:]' '[:upper:]')"
case "$LEVEL" in
  V|D|I|W|E|F|S) ;;
  *) echo "非法 LEVEL: $LEVEL（应为 V/D/I/W/E/F/S）"; exit 1 ;;
esac

case "$BUFFER" in
  main|system|events|radio|crash|all) ;;
  *) echo "非法 BUFFER: $BUFFER（应为 main/system/events/radio/crash/all）"; exit 1 ;;
esac

command -v adb >/dev/null 2>&1 || { echo "未检测到 adb（可用: brew install android-platform-tools）。"; exit 1; }

# 未指定 --serial 时，自动选择/交互选择 ADB 设备
if [[ -z "$SERIAL" ]]; then
  device_auto_select
fi

ADB=(adb)
[[ -n "$SERIAL" ]] && ADB+=( -s "$SERIAL" )
"${ADB[@]}" wait-for-device >/dev/null

$CLEAR && "${ADB[@]}" logcat -c || true

if [[ -n "$PACKAGE" ]]; then
  $RESTART && "${ADB[@]}" shell am force-stop "$PACKAGE" || true
  $LAUNCH && "${ADB[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 0.4
  if [[ -z "$PID" ]]; then
    PID="$("${ADB[@]}" shell pidof -s "$PACKAGE" 2>/dev/null || true)"
    if [[ -z "$PID" ]]; then
      # 兜底：使用 ps 匹配进程名列（最后一列）
      PID="$("${ADB[@]}" shell ps -A 2>/dev/null | awk -v p="$PACKAGE" '$NF==p{print $2; exit}')"
    fi
  fi
fi

# 处理 logcat -v 格式和颜色
if [[ -z "$FORMAT" ]]; then
  if $NO_COLOR; then
    FORMAT="threadtime,year"
  else
    FORMAT="color,threadtime,year"
  fi
else
  # 若显式关闭颜色，则移除 color 标记（任意位置）
  if $NO_COLOR; then
    FORMAT="${FORMAT//,color/}"
    FORMAT="${FORMAT//color,/}"
    FORMAT="${FORMAT//color/}"
  fi
fi

LC=(logcat -v "$FORMAT")
if [[ "$BUFFER" != "all" ]]; then
  LC+=( -b "$BUFFER" )
else
  LC+=( -b main -b system -b events -b radio -b crash )
fi
if [[ -n "$PID" ]]; then
  LC+=( --pid="$PID" )
fi

if [[ "$TAG" != "*" ]]; then
  IFS=',' read -r -a __tag_arr <<< "$TAG"
  __has_tag=false
  for __t in "${__tag_arr[@]}"; do
    __t="${__t//[[:space:]]/}"
    if [[ -n "$__t" ]]; then
      LC+=( "$__t:$LEVEL" )
      __has_tag=true
    fi
  done
  if [[ "$__has_tag" == false ]]; then
    LC+=( "*:$LEVEL" )
  else
    LC+=( "*:S" )
  fi
else
  LC+=( "*:$LEVEL" )
fi

# --tail/--since 互斥并追加给 logcat
if [[ -n "$TAIL_LINES" && -n "$SINCE_TIME" ]]; then
  echo "--tail 与 --since 不能同时使用"; exit 1
fi
[[ -n "$TAIL_LINES" ]] && LC+=( -T "$TAIL_LINES" )
[[ -n "$SINCE_TIME" ]] && LC+=( -T "$SINCE_TIME" )

# 输出目录与文件名
OUT_DIR="${OUT_DIR:-logs}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="logcat-${SERIAL:-device}-${PACKAGE:-all}-$STAMP"
RAW_PATH="${OUT_DIR}/${BASE}.raw"
TXT_PATH="${OUT_DIR}/${BASE}.log"

# 运行配置汇总输出
DEVICE_SN="$(${ADB[@]} get-serialno 2>/dev/null || echo "unknown")"
if [[ "$BUFFER" == "all" ]]; then
  BUFFERS_SUMMARY="main,system,events,radio,crash"
else
  BUFFERS_SUMMARY="$BUFFER"
fi
COLOR_SUMMARY=$($NO_COLOR && echo off || echo on)
TAIL_SUMMARY=${TAIL_LINES:-"(unset)"}
SINCE_SUMMARY=${SINCE_TIME:-"(unset)"}
PID_SUMMARY=${PID:-"(unset)"}
PACKAGE_SUMMARY=${PACKAGE:-"(unset)"}
TAGS_SUMMARY="$TAG"
if [[ "$TAGS_SUMMARY" != "*" ]]; then
  TAGS_SUMMARY="$(echo "$TAGS_SUMMARY" | tr -d '[:space:]') (*:S applied)"
fi

echo "# === Logcat Run Config ==="
echo "Device Serial   : $DEVICE_SN"
echo "Package         : $PACKAGE_SUMMARY"
echo "Resolved PID    : $PID_SUMMARY"
echo "Buffer(s)       : $BUFFERS_SUMMARY"
echo "Level           : $LEVEL"
echo "Tags            : $TAGS_SUMMARY"
echo "Include Regex   : ${GREP_REGEX:-"(unset)"}"
echo "Exclude Regex   : ${EXCLUDE_REGEX:-"(unset)"}"
echo "Format          : $FORMAT"
echo "Color           : $COLOR_SUMMARY"
echo "Tail Lines      : $TAIL_SUMMARY"
echo "Since Time      : $SINCE_SUMMARY"
echo "Duration        : ${DURATION:-"(unset)"}"
echo "Save            : $($SAVE && echo yes || echo no)"
echo "Raw File        : $($RAW_FILE && echo yes || echo no)"
echo "Out Dir         : ${OUT_DIR}/"
echo "Output File     : $TXT_PATH"
echo "# ========================="
echo "(按 p 暂停/恢复显示，按 q 退出)"

# 若保存，则将运行配置写入文件首部，随后日志以追加方式写入
if $SAVE; then
  {
    echo "# === Logcat Run Config ==="
    echo "Device Serial   : $DEVICE_SN"
    echo "Package         : $PACKAGE_SUMMARY"
    echo "Resolved PID    : $PID_SUMMARY"
    echo "Buffer(s)       : $BUFFERS_SUMMARY"
    echo "Level           : $LEVEL"
    echo "Tags            : $TAGS_SUMMARY"
    echo "Include Regex   : ${GREP_REGEX:-"(unset)"}"
    echo "Exclude Regex   : ${EXCLUDE_REGEX:-"(unset)"}"
    echo "Format          : $FORMAT"
    echo "Color           : $COLOR_SUMMARY"
    echo "Tail Lines      : $TAIL_SUMMARY"
    echo "Since Time      : $SINCE_SUMMARY"
    echo "Duration        : ${DURATION:-"(unset)"}"
    echo "Save            : $($SAVE && echo yes || echo no)"
    echo "Raw File        : $($RAW_FILE && echo yes || echo no)"
    echo "Out Dir         : ${OUT_DIR}/"
    echo "Output File     : $TXT_PATH"
    echo "# ========================="
    echo
  } > "$TXT_PATH"
  if $RAW_FILE; then
    {
      echo "# === Logcat Run Config ==="
      echo "Device Serial   : $DEVICE_SN"
      echo "Package         : $PACKAGE_SUMMARY"
      echo "Resolved PID    : $PID_SUMMARY"
      echo "Buffer(s)       : $BUFFERS_SUMMARY"
      echo "Level           : $LEVEL"
      echo "Tags            : $TAGS_SUMMARY"
      echo "Include Regex   : ${GREP_REGEX:-"(unset)"}"
      echo "Exclude Regex   : ${EXCLUDE_REGEX:-"(unset)"}"
      echo "Format          : $FORMAT"
      echo "Color           : $COLOR_SUMMARY"
      echo "Tail Lines      : $TAIL_SUMMARY"
      echo "Since Time      : $SINCE_SUMMARY"
      echo "Duration        : ${DURATION:-"(unset)"}"
      echo "Save            : $($SAVE && echo yes || echo no)"
      echo "Raw File        : $($RAW_FILE && echo yes || echo no)"
      echo "Out Dir         : ${OUT_DIR}/"
      echo "Output File     : $TXT_PATH"
      echo "# ========================="
      echo
    } > "$RAW_PATH"
  fi
fi

# 启动 PID 映射刷新（替代原内联后台协程）
start_pidmap_refresher
# 清理在统一 cleanup 中处理

# 按键监听改为内联到 pausable_sink 前台进程中，无需在此启动

# 定时结束（如设置）
if [[ -n "$DURATION" ]]; then
  (
    sleep "$DURATION"
    echo
    echo "到时自动结束（$DURATION s）"
    kill -INT $$ 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!
fi

PIPELINE="run_with_color | filter_lines | inject_process_name_all"

# 若仅提供 PACKAGE 而未指定 PID，则动态按包名过滤（可自动跟随重启变化的 PID）
if [[ -z "$PID" && -n "$PACKAGE" ]]; then
  export FILTER_PACKAGE="$PACKAGE"
  PIPELINE+=" | filter_by_package_dynamic"
  TAGS_SUMMARY="$TAGS_SUMMARY (pkg-dynamic)"
fi

if $SAVE; then
  if $RAW_FILE; then
    eval "$PIPELINE" | tee -a "$RAW_PATH" | strip_ansi >> "$TXT_PATH"
    echo "已保存：$RAW_PATH（彩色），$TXT_PATH（去色）"
  else
    eval "$PIPELINE" | strip_ansi >> "$TXT_PATH"
    echo "已保存：$TXT_PATH（去色）"
  fi
else
  eval "$PIPELINE" | pausable_sink
fi


