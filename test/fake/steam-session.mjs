// Offline stand-in for steam-session: just enough surface for the imports, the
// token renewal and the QR login. A test sets LoginSession.qrStart to script
// what startWithQR resolves with.
import { EventEmitter } from 'node:events';

export class LoginSession extends EventEmitter {
  static qrStart = null;

  constructor(platformType) {
    super();
    this.platformType = platformType;
  }

  setRefreshToken(token) {
    this.refreshToken = token;
  }

  async renewRefreshToken() {
    return false;
  }

  startWithQR() {
    return LoginSession.qrStart ? LoginSession.qrStart(this) : new Promise(() => {});
  }

  cancelLoginAttempt() {}
}

export const EAuthTokenPlatformType = { SteamClient: 1, WebBrowser: 2, MobileApp: 3 };
export const EAuthSessionGuardType = { Unknown: 0, None: 1, EmailCode: 2, DeviceCode: 3, DeviceConfirmation: 4, EmailConfirmation: 5, MachineToken: 6 };
