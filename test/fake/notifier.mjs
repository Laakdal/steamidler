// Offline stand-in for DiscordNotifier (the NotifierLike surface in runtime.ts): records every message.
export function createFakeNotifier() {
  const notifier = {
    sent: [],
    send(text) {
      notifier.sent.push(text);
      return Promise.resolve();
    },
    botConfig: () => null,
    isConfigured: () => false,
    hasFile: () => false,
    reload() {},
  };
  return notifier;
}
