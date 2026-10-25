// Maps the network libraries to offline fakes so the compiled code never touches Discord or Steam.
const fakes = {
  'discord.js': new URL('./discord.mjs', import.meta.url).href,
  'steam-user': new URL('./steam-user.mjs', import.meta.url).href,
  'steam-session': new URL('./steam-session.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(fakes, specifier)) return { url: fakes[specifier], shortCircuit: true };
  return next(specifier, context);
}
