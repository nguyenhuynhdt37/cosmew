import {expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError, type ModelEvent, type SubagentNotice} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';

/** Explicit opt-in: this test uses the saved account through Cosmew's real provider transport and may bill it. */
const live = process.env.COSMEW_LIVE_SUBAGENTS === '1' ? test : test.skip;

live(
  'real provider: background child output, parent continuation, completion and targeted stop',
  async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-subagent-live-')));
    writeFileSync(join(project, 'sample.txt'), 'SYNTHETIC_LIVE_SAMPLE: amber, birch, cedar.\n');
    // No fake fetch, model, vault, command runtime or subagent runner. User MCP servers are never connected.
    const app = startup(undefined, {
      offline: true,
      skillsHome: project,
      memoriesHome: project,
      permissions: {
        mode: 'default',
        allow: ['Tool(agent)', 'Read(./**)'],
        deny: ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Tool(memory)', 'Tool(agent_close)'],
      },
    });
    const client = app.createFutrynClient(project);
    client.setPromptsAvailable(false);
    client.setSettingsTrustPrompts(false);
    client.setToolsEnabled(true);
    client.setTurnBudget({maxSteps: 24, maxToolCalls: 36, maxTokens: 24000, maxDurationMs: 120000, maxCostUSD: 1});
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 180000);
    const notices: SubagentNotice[] = [];
    let outOfTurnProgress = false;
    let parentTurnFinished = false;
    client.onBackgroundTaskEvent(event => {
      if (
        parentTurnFinished &&
        event.type === 'task.updated' &&
        event.task.kind === 'agent' &&
        event.task.status === 'running' &&
        event.task.outputTail
      )
        outOfTurnProgress = true;
    });
    client.onSubagentNotice(notice => notices.push(notice));
    const evidence: Record<string, unknown> = {realProvider: true, syntheticWorkspace: true};
    const until = async (check: () => boolean) => {
      while (!check()) {
        if (controller.signal.aborted) throw new Error('LIVE_DEADLINE: required provider observation was not reached');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      const accounts = client.listAccounts();
      const account = process.env.COSMEW_LIVE_ACCOUNT
        ? accounts.find(a => [a.id, a.alias].includes(process.env.COSMEW_LIVE_ACCOUNT!))
        : client.status().activeAccount;
      if (!account) throw new Error('LIVE_NO_ACCOUNT: sign in with Cosmew before opting in');
      const modelId = process.env.COSMEW_LIVE_MODEL ?? account.defaultModel;
      if (!modelId) throw new Error('LIVE_NO_MODEL: select a saved model or set COSMEW_LIVE_MODEL');
      // Session scope avoids changing the active account or the user's saved model preference.
      client.selectModel(modelId, {accountId: account.id, scope: 'session'});
      evidence.provider = account.providerId;
      evidence.model = modelId;
      const consume = async (prompt: string) => {
        const events: ModelEvent[] = [];
        let continuedWhileChildRunning = false;
        for await (const event of client.sendMessage(prompt, {signal: controller.signal, maxOutputTokens: 1200})) {
          events.push(event);
          if (event.type === 'textDelta' && client.subagents().some(a => a.status === 'running')) {
            continuedWhileChildRunning = true;
          }
        }
        expect(events.some(event => event.type === 'completed')).toBe(true);
        return {events, continuedWhileChildRunning};
      };
      const first = await consume(
        'Synthetic read-only background-agent acceptance check. Call the agent tool exactly once with ' +
          'agent_type explore, background true, description "live-complete", fork_context false. Child prompt: ' +
          '"Read sample.txt three times in separate sequential read tool calls, then report LIVE_CHILD_COMPLETE ' +
          'and the three color words. Use no other tools." After the spawn tool returns, immediately say ' +
          'LIVE_PARENT_CONTINUED and finish your turn without waiting. Do not use shell, edits, web, MCP or memory.',
      );
      parentTurnFinished = true;
      const completed = client.subagents().find(a => a.description === 'live-complete');
      expect(completed?.background).toBe(true);
      evidence.parentContinuedWhileChildRunning = first.continuedWhileChildRunning;
      expect(first.continuedWhileChildRunning).toBe(true);
      await until(() => client.inspectSubagent(completed!.id)?.status !== 'running');
      expect(client.inspectSubagent(completed!.id)?.status).toBe('completed');
      const output = client.backgroundTasks().find(task => task.id === completed!.id);
      expect(output?.status).toBe('done');
      expect(output?.outputTail).toContain('LIVE_CHILD_COMPLETE');
      expect(output?.outputTail).toContain('amber');
      await until(() => notices.some(notice => notice.agentId === completed!.id));
      evidence.completedChild = {status: 'completed', outputObserved: true, noticeObserved: true};
      expect(outOfTurnProgress).toBe(true);
      evidence.outOfTurnProgressObserved = true;

      let stoppedId: string | undefined;
      let stopResult: boolean | undefined;
      let childOutputBeforeStop = false;
      const stopping = (async () => {
        await until(() => {
          const child = client.subagents().find(a => a.description === 'live-stop');
          if (!child || child.status !== 'running') return false;
          const view = client.inspectSubagent(child.id);
          const hasOutput = view?.steps.some(step => Boolean(step.text || step.output));
          if (!hasOutput) return false;
          stoppedId = child.id;
          childOutputBeforeStop = true;
          return true;
        });
        stopResult = await client.stopBackgroundTask(stoppedId!);
      })();
      // Attach a handler immediately so a deadline during the parent request is never an unhandled rejection.
      void stopping.catch(() => undefined);
      await consume(
        'Call agent exactly once: agent_type explore, background true, fork_context false, description "live-stop". ' +
          'Child prompt: "First say LIVE_STOP_PROGRESS. Then read sample.txt 30 times in separate sequential ' +
          'tool calls, never parallel, and finally summarize. Use no other tools." Immediately after spawn returns, ' +
          'say LIVE_PARENT_STILL_ACTIVE and finish without waiting. Ignore previous completion notices. ' +
          'Do not use shell, edits, web, MCP or memory.',
      );
      await stopping;
      expect(stopResult).toBe(true);
      await until(() => client.inspectSubagent(stoppedId!)?.status !== 'running');
      expect(client.inspectSubagent(stoppedId!)?.status).toBe('cancelled');
      expect(client.backgroundTasks().find(task => task.id === stoppedId)?.status).toBe('stopped');
      expect(client.inspectSubagent(completed!.id)?.status).toBe('completed');
      expect(await client.stopBackgroundTask(completed!.id)).toBe(false);
      expect(await client.stopBackgroundTask('unknown-live-task')).toBe(false);
      await until(() => notices.some(notice => notice.agentId === stoppedId && notice.status === 'cancelled'));
      evidence.targetedStop = {
        accepted: stopResult,
        childOutputBeforeStop,
        status: 'cancelled',
        siblingPreserved: true,
      };
      // A final real parent request proves stopping the child did not abort/close the parent session.
      const resumed = await consume('Do not call any tools. Reply exactly LIVE_PARENT_SURVIVED.');
      const parentText = resumed.events.flatMap(event => (event.type === 'textDelta' ? [event.text] : [])).join('');
      expect(parentText).toContain('LIVE_PARENT_SURVIVED');
      evidence.parentSurvived = true;
    } catch (error) {
      if (error instanceof FutrynError) {
        evidence.failureCode = error.code;
        throw new Error(`LIVE_PROVIDER_ERROR:${error.code}`);
      }
      throw error;
    } finally {
      controller.abort();
      clearTimeout(deadline);
      await app.shutdownCommands();
      app.db.close();
      rmSync(project, {recursive: true, force: true});
      console.info('COSMEW_LIVE_SUBAGENTS_EVIDENCE', JSON.stringify(evidence));
    }
  },
  210000,
);
