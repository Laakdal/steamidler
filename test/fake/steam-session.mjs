// Offline stand-in for steam-session: just enough surface for the imports and the token renewal.
export class LoginSession {
  constructor(platformType) {
    this.platformType = platformType;
  }

  setRefreshToken(token) {
    this.refreshToken = token;
  }

  async renewRefreshToken() {
    return false;
  }
}

export const EAuthTokenPlatformType = { SteamClient: 1, WebBrowser: 2, MobileApp: 3 };
export const EAuthSessionGuardType = { Unknown: 0, None: 1, EmailCode: 2, DeviceCode: 3, DeviceConfirmation: 4, EmailConfirmation: 5, MachineToken: 6 };
