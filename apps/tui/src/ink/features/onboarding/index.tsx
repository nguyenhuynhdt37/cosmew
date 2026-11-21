/** @jsxImportSource react */
import {useState} from 'react';
import {Box} from 'ink';
import {useFutrynClient, useKeymap} from '../../hooks';
import {useTheme} from '../../theme';
import {Panel, TextLine} from '../../ui';
import {ConnectDialog} from '../connect';
import {ThemesDialog} from '../themes';
import {isOnboardingStep, nextStep, type OnboardingStep} from './logic';

export function useOnboarding() {
  const client = useFutrynClient();
  const [initial] = useState(() => {
    const saved = client.onboardingState();
    if (!saved) return;
    const hasAccount = client.listAccounts().some(account => account.status !== 'logged-out');
    const completed = saved.completed.filter(isOnboardingStep);
    const inheritedTheme = hasAccount && saved.hasStoredTheme && !completed.includes('theme');
    if (inheritedTheme) completed.push('theme');
    return {completed, hasAccount, inheritedTheme};
  });
  const [completed, setCompleted] = useState(initial?.completed ?? []);
  const step = initial ? nextStep(completed, initial.hasAccount) : undefined;
  return {
    step,
    finish() {
      if (!step) return;
      // Save inferred upgrade steps as well, so later logout does not reopen onboarding.
      if (step === 'security' && initial?.hasAccount) {
        if (initial.inheritedTheme) client.completeOnboardingStep('theme');
        client.completeOnboardingStep('auth');
      }
      client.completeOnboardingStep(step);
      setCompleted([...completed, step]);
    },
  };
}

export function Onboarding({step, finish, width}: {step: OnboardingStep; finish(): void; width?: number}) {
  if (step === 'theme') return <ThemesDialog width={width} onOnboardingSelect={finish} />;
  if (step === 'auth') return <ConnectDialog width={width} onOnboardingDone={finish} />;
  return <SecurityNotes width={width} onContinue={finish} />;
}

function SecurityNotes({width, onContinue}: {width?: number; onContinue(): void}) {
  const {color} = useTheme();
  useKeymap({submit: onContinue});
  return (
    <Panel width={width} ruleStyle="dialog" title="Security notes:">
      <Box height={1} />
      <TextLine bold>Cosmew can make mistakes.</TextLine>
      <TextLine>Review Cosmew’s actions, especially when it runs code.</TextLine>
      <Box height={1} />
      <TextLine>Due to prompt injection risks, use Cosmew only with code you trust.</TextLine>
      <Box height={1} />
      <TextLine color={color('foregroundMuted')}>Enter to continue</TextLine>
    </Panel>
  );
}
