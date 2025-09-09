import { DeviceInfo } from '../utils/adb';
import { LastConfig } from '../state/configStore';

// 来自 Webview 的入站消息
export type ReadyMessage = { type: 'ready' };
export type RequestHistoryMessage = { type: 'requestHistory'; serial: string };
export type ClearMessage = { type: 'clear' };
export type RefreshDevicesMessage = { type: 'refreshDevices' };
export type StartMessage = {
  type: 'start';
  serial: string;
  pkg?: string;
  tag?: string; // default '*'
  level?: string; // default 'D'
  buffer?: string; // default 'main'
  save?: boolean;
};
export type PauseMessage = { type: 'pause' };
export type StopMessage = { type: 'stop' };

export type IncomingWebviewMessage =
  | ReadyMessage
  | RequestHistoryMessage
  | ClearMessage
  | RefreshDevicesMessage
  | StartMessage
  | PauseMessage
  | StopMessage;

// 发送到 Webview 的出站消息
export type AppendMessage = { type: 'append'; text: string };
export type StatusMessage = { type: 'status'; text: string };
export type DevicesMessage = { type: 'devices'; devices: DeviceInfo[]; defaultSerial?: string };
export type ConfigMessage = { type: 'config'; config: LastConfig };
export type DebugMessage = { type: 'debug'; enabled: boolean };
export type VisibleMessage = { type: 'visible' };
export type HistoryDumpMessage = { type: 'historyDump'; text: string };

export type OutgoingWebviewMessage =
  | AppendMessage
  | StatusMessage
  | DevicesMessage
  | ConfigMessage
  | DebugMessage
  | VisibleMessage
  | HistoryDumpMessage;


