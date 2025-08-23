#!/usr/bin/env bash

# 用 script 伪 TTY，确保颜色在管道中保留（与原逻辑一致）
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


