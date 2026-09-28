/** Device-local preferences (never shared with the room). */
import { randomId, sanitizePlayerName } from '@lll/shared';

export interface Settings {
  playerName: string;
  monitoring: boolean;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  masterVolume: number;
  inputDeviceId: string;
}

const KEY = 'lll.settings.v1';

const defaults: Settings = {
  playerName: '',
  monitoring: false,
  metronomeEnabled: false,
  metronomeVolume: 0.5,
  masterVolume: 1,
  inputDeviceId: '',
};

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function displayName(settings: Settings): string {
  return sanitizePlayerName(settings.playerName);
}

/**
 * Per-tab identity: author id of this player's takes and peer id in rooms.
 * sessionStorage survives reloads (so "undo my take" keeps working) while two
 * tabs still count as two players, which is handy for testing.
 */
export function tabUserId(): string {
  const key = 'lll.userId';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = randomId(12);
    sessionStorage.setItem(key, id);
  }
  return id;
}
