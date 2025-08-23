#!/usr/bin/env bash

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

# 动态按包名过滤：当未显式指定 --pid 而提供了 PACKAGE 时使用
# 依赖外部变量：FILTER_PACKAGE、PID_MAP_PATH
filter_by_package_dynamic() {
  PKG="$FILTER_PACKAGE" MAP_PATH="$PID_MAP_PATH" perl -ne '
    use strict; use warnings;
    our ($target_pkg, $map_path, %pid_name, $last_loaded);
    BEGIN {
      $| = 1;
      $target_pkg = defined $ENV{PKG} ? $ENV{PKG} : "";
      $map_path   = defined $ENV{MAP_PATH} ? $ENV{MAP_PATH} : "";
      %pid_name = ();
      $last_loaded = 0;
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
    # 解析 threadtime:  date time pid tid level tag:
    if ($stripped =~ /^(?:\S+\s+){2}(\d+)\s+\d+\s+\w\s+\S+:\s/) {
      my $pid = $1;
      my $name = exists $pid_name{$pid} ? $pid_name{$pid} : "";
      if (length $target_pkg) {
        if ($name eq $target_pkg) { print $raw; }
      } else {
        print $raw;
      }
    } else {
      # 非标准行（如分隔线等）直接透传
      print $raw;
    }
  '
}


