// Offline stand-in for steam-user: records the calls the app makes and talks to nobody.
import { EventEmitter } from 'node:events';

export default class SteamUser extends EventEmitter {
  static EPersonaState = { Online: 1 };
  static EResult = {};
  EPersonaState = SteamUser.EPersonaState;
  EResult = SteamUser.EResult;
  steamID = null;

  constructor(options) {
    super();
    this.options = options;
    this.personaCalls = [];
    this.logOnCalls = [];
    this.logOffCalls = 0;
    this.gamesPlayedCalls = [];
  }

  setPersona(state) {
    this.personaCalls.push(state);
  }

  logOn(details) {
    this.logOnCalls.push(details);
  }

  logOff() {
    this.logOffCalls += 1;
  }

  gamesPlayed(ids) {
    this.gamesPlayedCalls.push(ids);
  }
}
