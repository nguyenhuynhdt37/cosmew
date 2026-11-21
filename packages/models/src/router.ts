import {FutrynError, type Account, type ModelInfo, type Selection, type SettingsStore} from '@cosmew/contracts';
export class ModelRouter {
  constructor(private readonly store: SettingsStore) {}
  select(account: Account, model: ModelInfo, project?: string): Selection {
    if (account.status === 'logged-out') throw new FutrynError('AUTH');
    const selection = {accountId: account.id, modelId: model.id};
    this.store.update(s => {
      if (
        !s.accounts.some(a => a.id === account.id && a.providerId === account.providerId && a.status !== 'logged-out')
      )
        throw new FutrynError('POLICY');
      if (!s.catalogs.some(c => c.accountId === account.id && c.models.some(m => m.id === model.id)))
        throw new FutrynError('NOT_FOUND');
      s.activeAccountId = account.id;
      if (project) s.projects[project] = selection;
      else s.selection = selection;
      s.accounts.find(a => a.id === account.id)!.defaultModel = model.id;
    });
    return selection;
  }
  resolve(project?: string): Selection {
    const state = this.store.read();
    const selected = (project && state.projects[project]) || state.selection;
    if (!selected || !state.accounts.some(a => a.id === selected.accountId && a.status !== 'logged-out'))
      throw new FutrynError('POLICY');
    return selected;
  }
}
