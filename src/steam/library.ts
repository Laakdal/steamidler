import type { SteamGame } from '../types/index.js';

// Billing types of licenses that cost nothing: no-cost, guest pass, free on
// demand, free commercial license. A game held only through these is "free".
const FREE_BILLING = new Set([0, 3, 5, 12]);

// What the owned-apps call returns for one app
export interface OwnedAppEntry {
  appid: number;
  name?: string;
  playtime_forever?: number;
}

// The parts of steam-user's license list and PICS cache the tagging needs
export interface LicenseData {
  licenses: { owner_id: number; package_id: number }[];
  packages: Record<number, { packageinfo?: { appids?: number[]; billingtype?: number } | null } | undefined>;
  appNames: (appid: number) => string | undefined;
}

// How the account holds one app, summed over every license that contains it
interface Holding {
  lent: boolean; // in a package another family member owns
  own: boolean; // in a package of our own
  paid: boolean; // one of our own packages for it is not a free billing type
}

// Folds the license list into one Holding per appid
function holdings(data: LicenseData, ownAccountId: number): Map<number, Holding> {
  const byApp = new Map<number, Holding>();
  for (const license of data.licenses) {
    const info = data.packages[license.package_id]?.packageinfo;
    for (const appid of info?.appids ?? []) {
      const h = byApp.get(appid) ?? { lent: false, own: false, paid: false };
      if (license.owner_id !== ownAccountId) {
        h.lent = true;
      } else {
        h.own = true;
        if (info?.billingtype !== undefined && !FREE_BILLING.has(info.billingtype)) h.paid = true;
      }
      byApp.set(appid, h);
    }
  }
  return byApp;
}

// Turns the owned-apps answer into the library: each game tagged owned, free
// or shared. Steam leaves some family-shared games out of that answer, so
// every lent app it did not list is added after the rest, named from the PICS
// cache. Without license data (null) every game counts as owned.
export function buildLibrary(owned: OwnedAppEntry[], data: LicenseData | null, ownAccountId: number): SteamGame[] {
  const held = data ? holdings(data, ownAccountId) : new Map<number, Holding>();
  const sourceOf = (appid: number): SteamGame['source'] => {
    const h = held.get(appid);
    if (h?.lent) return 'shared';
    return h?.own && !h.paid ? 'free' : 'owned';
  };

  const games: SteamGame[] = owned.map((app) => ({
    appid: app.appid,
    name: app.name || `App ${app.appid}`,
    playtime_forever: app.playtime_forever || 0,
    source: sourceOf(app.appid),
  }));

  const listed = new Set(games.map((g) => g.appid));
  for (const [appid, h] of held) {
    if (!h.lent || listed.has(appid)) continue;
    games.push({ appid, name: data?.appNames(appid) || `App ${appid}`, playtime_forever: 0, source: 'shared' });
  }
  return games;
}
