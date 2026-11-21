export type OnboardingStep = 'theme' | 'auth' | 'security';

export function isOnboardingStep(id: string): id is OnboardingStep {
  return id === 'theme' || id === 'auth' || id === 'security';
}

export function nextStep(done: readonly OnboardingStep[], hasAccount: boolean): OnboardingStep | undefined {
  if (!done.includes('theme')) return 'theme';
  if (!hasAccount && !done.includes('auth')) return 'auth';
  if (!done.includes('security')) return 'security';
}
