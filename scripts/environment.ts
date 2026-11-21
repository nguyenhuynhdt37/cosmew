/** Script configuration uses COSMEW_*; older prefixes are read-only compatibility fallbacks. */
export function scriptEnvironment(name: string, environment: Record<string, string | undefined> = process.env) {
  return environment[`COSMEW_${name}`] ?? environment[`FUTRYN_${name}`] ?? environment[`HANNES_${name}`];
}
