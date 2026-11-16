import {SLASH_COMMANDS} from '../composer';

export function filterPaletteCommands(query: string) {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    c =>
      c.command.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.aliases.some(a => a.toLowerCase().includes(q)),
  );
}
