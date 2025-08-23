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


