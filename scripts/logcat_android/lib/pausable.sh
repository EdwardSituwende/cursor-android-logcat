#!/usr/bin/env bash

# 可暂停输出支持：
# - 启动后台键盘监听（原始模式），按 p 切换暂停/恢复；按 q/CTRL-C 退出
# - pausable_sink: 从 STDIN 读取日志流，根据状态决定是否吞吐

PAUSE_STATE_FILE="${PAUSE_STATE_FILE:-}"
KEY_LISTENER_PID="${KEY_LISTENER_PID:-}"

_ensure_pause_state_file() {
  if [[ -z "$PAUSE_STATE_FILE" ]]; then
    PAUSE_STATE_FILE="$(mktemp -t logcat_pause.XXXXXX)"
  fi
  # 默认运行态：0 表示继续输出，1 表示暂停
  printf '0' > "$PAUSE_STATE_FILE"
}

start_key_listener() {
  _ensure_pause_state_file
  # 在无交互 TTY 的环境（如重定向/CI）下跳过监听
  if [[ ! -e /dev/tty ]]; then
    return
  fi
  (
    # 保存并设置终端为原始无回显模式
    stty_state=$(stty -g < /dev/tty 2>/dev/null || true)
    stty -echo -icanon time 0 min 0 < /dev/tty 2>/dev/null || true
    trap 'stty "$stty_state" < /dev/tty 2>/dev/null || true; exit 0' EXIT INT TERM
    while true; do
      # 非阻塞读取单个按键
      if IFS= read -r -n1 key < /dev/tty 2>/dev/null; then
        case "$key" in
          p|P)
            cur=$(cat "$PAUSE_STATE_FILE" 2>/dev/null || echo 0)
            if [[ "$cur" == "0" ]]; then echo 1 > "$PAUSE_STATE_FILE"; else echo 0 > "$PAUSE_STATE_FILE"; fi
            ;;
          q|Q)
            # 发 SIGINT 给父进程（主脚本），用于优雅退出
            kill -INT "$PPID" 2>/dev/null || true
            ;;
          *) ;;
        esac
      else
        # 轻微休眠以降低 CPU
        sleep 0.05
      fi
    done
  ) & KEY_LISTENER_PID=$!
}

# 在暂停期间：
# - 终端显示被暂停；
# - 若设置了 SAVE/RAW_FILE 的 tee 分支，则文件仍然写入（本 sink 只用于终端显示路径）。
pausable_sink() {
  _ensure_pause_state_file
  STATE_PATH="$PAUSE_STATE_FILE" perl -ne '
    use strict; use warnings;
    use IO::Select;
    use POSIX qw(getpgrp);
    our ($state_path, $prev_paused, $dropped, $paused_mem, $have_tty, $tty, $sel, $stty_saved);
    BEGIN {
      $| = 1;
      $state_path = defined $ENV{STATE_PATH} ? $ENV{STATE_PATH} : "";
      $prev_paused = 0;
      $dropped = 0;
      $paused_mem = 0;
      $have_tty = 0;
      if (-e "/dev/tty") {
        if (open($tty, "<", "/dev/tty")) {
          binmode($tty);
          $sel = IO::Select->new();
          $sel->add($tty);
          $have_tty = 1;
          # 保存并临时设置为原始非阻塞键入
          chomp($stty_saved = `stty -g < /dev/tty 2>/dev/null`);
          system("stty -echo -icanon time 0 min 0 < /dev/tty >/dev/null 2>&1");
        }
      }
    }
    END {
      if ($have_tty && defined $stty_saved && length $stty_saved) {
        system("stty $stty_saved < /dev/tty >/dev/null 2>&1");
      }
    }
    my $line = $_;
    # 先读取按键（非阻塞）
    if ($have_tty) {
      if ($sel->can_read(0)) {
        my $ch = "";
        my $n = sysread($tty, $ch, 1);
        if (defined $n && $n > 0) {
          if ($ch eq "p" || $ch eq "P") {
            $paused_mem = $paused_mem ? 0 : 1;
            if (length $state_path) {
              if (open my $of, ">", $state_path) { print $of ($paused_mem ? 1 : 0); close $of; }
            }
          } elsif ($ch eq "q" || $ch eq "Q") {
            # 向整个前台进程组发送 SIGINT，再自行退出
            kill "INT", -getpgrp();
            exit 0;
          }
        }
      }
    }
    my $paused = $paused_mem;
    if (length $state_path) {
      if (open my $fh, "<", $state_path) {
        my $s = <$fh>; close $fh; if (defined $s) { chomp $s; }
        $paused = ($s && $s ne "0") ? 1 : 0;
        $paused_mem = $paused;  # 同步内存态
      }
    }
    if ($paused) {
      $dropped++;
      $prev_paused = 1;
      next;
    }
    if ($prev_paused && $dropped > 0) {
      print "== 已恢复，暂停期间丢弃 ${dropped} 行 ==\n";
      $dropped = 0;
      $prev_paused = 0;
    }
    print $line;
  '
}

stop_key_listener() {
  [[ -n "${KEY_LISTENER_PID-}" ]] && kill "${KEY_LISTENER_PID}" 2>/dev/null || true
}

cleanup_pause_state() {
  [[ -n "${PAUSE_STATE_FILE-}" ]] && rm -f "${PAUSE_STATE_FILE}" 2>/dev/null || true
}


