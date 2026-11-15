import { parseSlashCommand } from '@hannes/sdk';
import type { TuiHost } from '../../core/feature';
import { OVERLAY_COMMANDS, isUnsupported, planEffort, unsupportedMessage } from './logic';

/** Parses and dispatches slash commands. Holds no state of its own. */
export class CommandRouter {
  constructor(private readonly host: TuiHost) {}

  async execute(rawInput: string): Promise<void> {
    const { host } = this;
    const { client } = host;
    host.clearSelection();
    const parsed = parseSlashCommand(rawInput);
    if (parsed.error) { host.setBanner(parsed.error); return; }
    const trimmed = parsed.input;
    const lower = trimmed.toLowerCase();
    const command = parsed.definition?.command;

    if (host.isStreaming && !parsed.definition?.duringRequest) {
      host.setBanner('Cancel the active response with Esc before changing accounts, model or session.');
      return;
    }
    if (parsed.definition?.unavailable) { host.setBanner(parsed.definition.unavailable); return; }
    if (command === '/usage' || command === '/context') { host.openOverlay(command.slice(1) as 'usage' | 'context'); return; }
    if (command === '/effort') { this.effort(parsed.args); return; }
    if (command === '/switch') { host.features.accounts.beginSwitch(parsed.args); return; }

    if (lower.startsWith('/model ')) {
      try { client.selectModel(trimmed.slice(7).trim()); host.syncTranscript(); host.setBanner('Model selected; started a fresh conversation.'); }
      catch (error) { host.setBanner(host.describeError(error)); }
      return;
    }
    if (lower.startsWith('/resume ')) {
      try { client.resumeSession(trimmed.slice(8).trim()); host.syncTranscript(); host.closeOverlay(); }
      catch (error) { host.setBanner(host.describeError(error)); }
      return;
    }
    if (isUnsupported(lower)) { host.setBanner(unsupportedMessage(trimmed, lower)); return; }
    if (lower === '/doctor') {
      host.setBanner('Diagnosing provider connectivity…');
      try { host.setBanner(await client.diagnose()); }
      catch (error) { host.setBanner(host.describeError(error)); }
      return;
    }
    if (command === '/theme') { host.openOverlay('themes'); return; }
    if (command === '/login') {
      if (parsed.args) {
        try { client.useAccount(parsed.args); host.syncTranscript(); host.openOverlay('models'); }
        catch (error) { host.setBanner(host.describeError(error)); }
        return;
      }
      host.openOverlay('connect');
      return;
    }
    if (command === '/logout') { host.features.accounts.beginLogout(parsed.args); return; }
    if (command === '/accounts') { host.features.accounts.beginAccounts(parsed.args); return; }

    const overlay = OVERLAY_COMMANDS[lower];
    if (overlay) { host.openOverlay(overlay); return; }

    if (lower === '/clear') {
      client.clearSessionView();
      host.clearTranscript();
      host.closeOverlay();
      host.setBanner('Started a fresh conversation. Previous sessions remain in /resume.');
      return;
    }
    if (lower === '/exit' || lower === '/quit') {
      if (host.themeEngine.isPreviewing()) host.themeEngine.cancelPreview();
      host.requestExit();
      return;
    }
    host.setBanner(`Unknown slash command "${trimmed}". Type /help or press Ctrl+P for commands.`);
  }

  private effort(args: string): void {
    const { host } = this;
    try {
      const available = host.client.status().activeModel?.reasoningEfforts ?? [];
      const plan = planEffort(args, available);
      if (plan.kind === 'banner') { host.setBanner(plan.message); return; }
      if (plan.kind === 'open') { host.openOverlay('effort'); return; }
      if (plan.level !== null) host.client.setReasoningEffort(plan.level);
      host.setBanner(`Effort: ${host.client.status().reasoningEffort ?? 'provider default'}. Available: ${available.join(', ')}.`);
    } catch (error) { host.setBanner(host.describeError(error)); }
  }
}
