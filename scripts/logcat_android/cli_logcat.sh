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

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]
  -s, --serial SERIAL     指定设备序列号（未指定时：若仅 1 台自动选择；≥2 台交互选择）
  -p, --package NAME      包名（自动解析 PID）
      --pid PID           指定 PID（优先于包名）
  -t, --tag TAG           Tag（默认 *，支持逗号分隔多 Tag，如：TagA,TagB）
  -l, --level LEVEL       V/D/I/W/E/F/S（默认 D）
  -b, --buffer NAME       main/system/events/radio/crash/all（默认 main）
  -g, --grep REGEX        包含过滤（正则）
      --exclude REGEX     排除过滤（正则）
  -f, --save              保存到 logs/ 下带时间戳文件（终端彩色 + 文件去色）
  -c, --clear             开始前清空 logcat 缓冲
      --launch            若有包名，尝试冷启动
      --restart           若有包名，先 force-stop 再启动（配合 --launch）
      --raw-file          同时保存“带 ANSI 颜色”的原始文件
      --tail N            先显示缓冲区最近 N 行，再继续实时输出（等价 logcat -T N）
      --since TIME        从指定时间开始（MM-DD HH:MM:SS.mmm），等价 logcat -T "TIME"
      --out DIR           输出目录（默认 logs/）
      --no-color          关闭彩色输出（便于匹配/复制）
      --duration SEC      运行指定秒数后自动结束
      --format FMT        指定 logcat -v 格式（默认 color,threadtime,year；配合 --no-color 默认为 threadtime,year）
  -h, --help              帮助
EOF
}

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
  DEV_SERIALS=()
  while IFS= read -r __s; do
    [[ -n "$__s" ]] && DEV_SERIALS+=("$__s")
  done < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')

  __count=${#DEV_SERIALS[@]}
  if [[ "$__count" -eq 0 ]]; then
    echo "未发现可用的 adb 设备（状态为 device）。"
    exit 1
  fi

  # 函数：查询型号与 IP
  __get_model() {
    adb -s "$1" shell getprop ro.product.model 2>/dev/null | tr -d '\r' | tr -d '\n'
  }
  __get_ip() {
    local sn="$1"
    if [[ "$sn" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+: ]]; then
      echo "${sn%%:*}"
      return
    fi
    adb -s "$sn" shell "ip -o -4 addr show | awk '/wlan|wifi|eth0/ {print \\\$4}' | head -n1" 2>/dev/null | tr -d '\r' | cut -d/ -f1
  }

  if [[ "$__count" -eq 1 ]]; then
    SERIAL="${DEV_SERIALS[0]}"
    __model="$(__get_model "$SERIAL")"; __model="${__model:-unknown}"
    __ip="$(__get_ip "$SERIAL")"; __ip="${__ip:-unknown}"
    echo "已自动选择设备：${SERIAL}（${__model}，IP: ${__ip}）"
  else
    DEV_MODELS=()
    DEV_IPS=()
    for sn in "${DEV_SERIALS[@]}"; do
      __m="$(__get_model "$sn")"; DEV_MODELS+=("${__m:-unknown}")
      __i="$(__get_ip "$sn")"; DEV_IPS+=("${__i:-unknown}")
    done
    echo "检测到多台设备，请选择："
    for ((i=0; i<__count; i++)); do
      printf "  [%d] %s  %-20s  IP:%s\n" "$((i+1))" "${DEV_SERIALS[i]}" "${DEV_MODELS[i]}" "${DEV_IPS[i]}"
    done
    while true; do
      read -r -p "输入序号选择设备: " __idx
      if [[ "$__idx" =~ ^[0-9]+$ ]] && (( __idx>=1 && __idx<=__count )); then
        SERIAL="${DEV_SERIALS[__idx-1]}"
        echo "已选择设备：${SERIAL}（${DEV_MODELS[__idx-1]}，IP: ${DEV_IPS[__idx-1]}）"
        break
      else
        echo "无效输入，请输入 1-${__count} 的数字。"
      fi
    done
  fi
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
[[ -n "$PID" ]] && LC+=( --pid="$PID" )

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

# 用 script 伪 TTY，确保颜色在管道中保留
# - Linux(util-linux): script -q -c "CMD" /dev/null
# - macOS(BSD):       script -q /dev/null bash -lc "CMD"
# 若 script 不可用，则直接执行（可能丢失颜色）
run_with_color() {
  local cmd_str
  # 安全拼接并保持每个参数的边界
  printf -v cmd_str '%q ' "${ADB[@]}" "${LC[@]}"
  # 若设置环境变量 DISABLE_SCRIPT=1，则直接执行，避免在无 TTY 环境下 script 报错
  if [[ "${DISABLE_SCRIPT-}" == "1" ]]; then
    bash -lc "$cmd_str"
    return
  fi
  if command -v script >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin)
        script -q /dev/null bash -lc "$cmd_str" ;;
      *)
        script -q -c "$cmd_str" /dev/null ;;
    esac
  else
    bash -lc "$cmd_str"
  fi
}

# 过滤函数：同时支持包含/排除
filter_lines() {
  INC="$GREP_REGEX" EXC="$EXCLUDE_REGEX" perl -ne '
    BEGIN {
      $| = 1;  # 立即输出，降低延迟
      our $inc = defined $ENV{INC} ? $ENV{INC} : "";
      our $exc = defined $ENV{EXC} ? $ENV{EXC} : "";
      our $hasInc = ($inc ne "");
      our $hasExc = ($exc ne "");
      our ($inc_re, $exc_re);
      if ($hasInc) { $inc_re = eval { qr/$inc/ }; $hasInc = $inc_re ? 1 : 0; }
      if ($hasExc) { $exc_re = eval { qr/$exc/ }; $hasExc = $exc_re ? 1 : 0; }
    }
    my $raw = $_;
    my $line = $raw;
    $line =~ s/\e\[[0-9;]*[mK]//g;  # 去掉 ANSI 后匹配
    if ($hasInc && $line !~ $inc_re) { next; }
    if ($hasExc && $line =~ $exc_re) { next; }
    print $raw;
  '
}

strip_ansi() {
  perl -pe 'BEGIN{$|=1} s/\e\[[0-9;]*[mK]//g'
}

# PID 映射文件与刷新
PID_MAP_PATH="$(mktemp -t pidmap.XXXXXX)"
update_pid_map() {
  "${ADB[@]}" shell ps -A 2>/dev/null | awk '
    NR==1 { next }
    {
      pid="";
      for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+$/) { pid=$i; break }
      if (pid=="") next;
      name=$NF;
      print pid, name;
    }
  ' > "$PID_MAP_PATH" || true
}
update_pid_map
(
  while true; do
    sleep 0.5
    update_pid_map
  done
) & PIDMAP_REFRESH_PID=$!
# 清理在统一 cleanup 中处理

# 为所有进程按 PID 注入进程名（在 Tag 与冒号之间）
inject_process_name_all() {
  MAP_PATH="$PID_MAP_PATH" perl -ne '
    use strict; use warnings;
    our ($map_path, %pid_name, $last_loaded);
    BEGIN {
      $| = 1;  # 立即输出，降低延迟
      $map_path = defined $ENV{MAP_PATH} ? $ENV{MAP_PATH} : "";
      $last_loaded = 0;
      %pid_name = ();
    }
    sub load_map {
      return unless length $map_path;
      if (open my $fh, "<", $map_path) {
        %pid_name = ();
        while (my $l = <$fh>) {
          chomp $l; next unless length $l;
          my ($p, $n) = split(/\s+/, $l, 2);
          next unless defined $p and defined $n;
          $pid_name{$p} = $n;
        }
        close $fh;
        $last_loaded = time();
      }
    }
    my $raw = $_;
    my $stripped = $raw;
    $stripped =~ s/\e\[[0-9;]*[mK]//g;
    if (time() - ($last_loaded||0) >= 1) { load_map(); }
    if ($stripped =~ /^(?:\S+\s+){2}(\d+)\s+\d+\s+\w\s+(\S+):\s/) {
      my ($pid, $tag) = ($1, $2);
      my $pkg = exists $pid_name{$pid} ? $pid_name{$pid} : "";
      if (length $pkg) {
        my $needle = " $tag:";
        my $idx = index($stripped, $needle);
        if ($idx >= 0) {
          my $colon_pos = $idx + length($needle) - 1; # 冒号下标（去色）
          my $visible = 0;
          my $out = "";
          my $i = 0;
          while ($i < length($raw)) {
            my $seg = substr($raw, $i);
            if ($seg =~ /^(\e\[[0-9;]*[mK])/) {
              my $ansi = $1;
              $out .= $ansi;
              $i += length($ansi);
              next;
            }
            my $ch = substr($raw, $i, 1);
            if ($visible == $colon_pos) { $out .= " $pkg"; }
            $out .= $ch;
            $visible++;
            $i++;
          }
          $_ = $out;
        }
      }
    }
    print $_;
  '
}

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

if $SAVE; then
  if $RAW_FILE; then
    run_with_color | filter_lines | inject_process_name_all | tee -a "$RAW_PATH" | strip_ansi >> "$TXT_PATH"
    echo "已保存：$RAW_PATH（彩色），$TXT_PATH（去色）"
  else
    run_with_color | filter_lines | inject_process_name_all | strip_ansi >> "$TXT_PATH"
    echo "已保存：$TXT_PATH（去色）"
  fi
else
  run_with_color | filter_lines | inject_process_name_all
fi


