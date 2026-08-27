/** Manifest command names — keep in sync with wxt.config.ts `manifest.commands`. */
export const COMMAND_START_CAPTURE = 'start-capture';
export const COMMAND_STOP_CAPTURE = 'stop-capture';
export const COMMAND_OPEN_SIDE_PANEL = 'open-side-panel';

export const COMMAND_DEFAULTS = {
  [COMMAND_START_CAPTURE]: 'Alt+Shift+R',
  [COMMAND_STOP_CAPTURE]: 'Alt+Shift+S',
  [COMMAND_OPEN_SIDE_PANEL]: 'Alt+Shift+T',
} as const;
