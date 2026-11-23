/** Script configuration uses COSMEW_* only. */
export function scriptEnvironment(name: string, environment: Record<string, string | undefined> = process.env) {
  return environment[`COSMEW_${name}`];
}
