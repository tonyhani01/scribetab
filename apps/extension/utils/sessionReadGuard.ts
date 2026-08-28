/** Token used to prevent a slow session read from applying after a switch. */
export interface SessionReadToken {
  sessionId: string;
  version: number;
}

export function canApplySessionRead(
  token: SessionReadToken,
  currentSessionId: string | null,
  currentVersion: number,
): boolean {
  return token.sessionId === currentSessionId && token.version === currentVersion;
}
