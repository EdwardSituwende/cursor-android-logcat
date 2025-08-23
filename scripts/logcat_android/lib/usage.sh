#!/usr/bin/env bash

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


