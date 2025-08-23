#!/usr/bin/env bash

# 设备自动选择/交互选择
__get_model() {
  adb -s "$1" shell getprop ro.product.model 2>/dev/null | tr -d '\r' | tr -d '\n'
}

__get_ip() {
  local sn="$1"
  if [[ "$sn" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+: ]]; then
    echo "${sn%%:*}"
    return
  fi
  adb -s "$sn" shell "ip -o -4 addr show | awk '/wlan|wifi|eth0/ {print \\${4}}' | head -n1" 2>/dev/null | tr -d '\r' | cut -d/ -f1
}

device_auto_select() {
  DEV_SERIALS=()
  while IFS= read -r __s; do
    [[ -n "$__s" ]] && DEV_SERIALS+=("$__s")
  done < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')

  __count=${#DEV_SERIALS[@]}
  if [[ "$__count" -eq 0 ]]; then
    echo "未发现可用的 adb 设备（状态为 device）。"
    exit 1
  fi

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
}


