const target = new URL('./discord.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'discord.js') return { url: target, shortCircuit: true };
  return next(specifier, context);
}
