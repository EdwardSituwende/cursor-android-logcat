#!/usr/bin/env bash

# 生成临时 PID 映射文件
PID_MAP_PATH="${PID_MAP_PATH:-$(mktemp -t pidmap.XXXXXX)}"

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

start_pidmap_refresher() {
  update_pid_map
  (
    while true; do
      sleep 0.5
      update_pid_map
    done
  ) & PIDMAP_REFRESH_PID=$!
}

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


