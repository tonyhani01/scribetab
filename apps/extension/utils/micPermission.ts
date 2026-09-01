export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export async function queryMicPermission(
  nav: Navigator = navigator,
): Promise<MicPermissionState> {
  try {
    if (!nav.permissions?.query) return 'unsupported';
    const status = await nav.permissions.query({ name: 'microphone' as PermissionName });
    return status.state as MicPermissionState;
  } catch {
    // 'microphone' is not a queryable permission in this context.
    return 'unsupported';
  }
}

export async function requestMicAccess(
  nav: Navigator = navigator,
): Promise<'granted' | 'denied'> {
  try {
    const stream = await nav.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return 'granted';
  } catch {
    // Prompt dismissed, blocked by Site settings, or no capture devices.
    return 'denied';
  }
}
