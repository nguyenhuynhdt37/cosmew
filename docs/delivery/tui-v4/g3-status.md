# G3 — integración transcript + entrada/footer + diálogos/paneles

Fecha: 2026-11-20. Spec: `spec.md`; ADR 0066. Capturas de Cosmew en `cosmew-g3/` (100x30, tema oscuro guardado del
usuario, HOME real; el modelo no recibió ningún prompt). `20-cmd-resume` está **redactada** (la lista real contenía
sesiones privadas del usuario).

## Cableado

- Ctrl+O = transcript detallado (`useDetailedTranscript`): footer `Showing detailed transcript · ctrl+o to toggle · ↑/↓ to scroll`
  + `verbose`, composer oculto, Esc sale. Ya no abre el panel History.
- Spinner de una línea (`Spinner` con `thinking`/`effort`/tip), `Plan` debajo, Ctrl+T alterna todos.
- `transcript.begin(prompt, id, model)`; las llamadas `!cmd` conservan su salida (no se fusionan).
- Resultados de comandos en el transcript: `❯ /cmd` + `  ⎿  resultado` pegados (`transcript.addCommand`); Esc en un panel
  abierto por un comando imprime `⎿  <Noun> cancelled` / `Closed <noun>` / `Diff panel hidden`; `/context` imprime la
  cuadrícula coloreada en el transcript (overlay solo durante un turno). `/rewind`, `/hooks`, `/mcp` son comandos de host
  (no están en `SLASH_COMMANDS`); Esc Esc abre Rewind; `/cost`/`/stats` abren la pestaña Stats.
- Ctrl+G ($VISUAL/$EDITOR sobre archivo temporal 0600) y Ctrl+Z (SIGTSTP) con `suspendTerminal` de Ink; Ctrl+X Ctrl+S
  (aborta el turno y envía la cola). `?` y `/help` comparten `HELP_SHORTCUT_COLUMNS` (sin imagen/`/btw`/`/keybindings`).
- Colores: `bashMode` claro `#ad7fa8`; token `toolSuccess` (`#4e9a06` / `#b5bd68`) solo para el `⏺`.

## Bugs reales encontrados

- `statsFields` lanzaba `UNSUPPORTED` (backend sin Git) y rompía el panel `/cost`: ahora tolerante.
- `Panel` reservaba 3 filas de más para el cuerpo (recortaba `NO SANDBOX` y el comando en terminales cortas) y emitía
  claves React duplicadas (`Encountered two children with the same key`) que ensuciaban la pantalla: corregido.
- Alias `/cost` se reescribía a `/usage` al aceptar el menú: ahora se ejecuta tal cual.
- Etiquetas de permiso cortas solo en terminales estrechas (<60 columnas) para no perder opciones.

## Diferencias históricas de G3 (antes de P1/P2)

| Frame | Diferencia |
|---|---|
| 00-trust | Texto de consentimiento de Cosmew (2 líneas extra de aviso de cuenta) |
| 01-ready | Sin línea `◐ effort` cuando el modelo no anuncia esfuerzo; sin `← N agent` (sin agentes) |
| 02-shortcuts | Sin `/btw`, `ctrl+v`, `/keybindings` (no existen); 6 filas en vez de 7 |
| 03-slash / 04-at | Comandos y archivos propios; descripciones se envuelven (sin elipsis) |
| 05-mode-* | Ciclo manual → accept edits → plan → manual (sin `auto`: bypass solo con flag) |
| 20-cmd-help | Texto de ayuda propio; sin `ctrl+v`, `/btw`, `/keybindings` |
| 20-cmd-config/status/cost | Campos propios de Cosmew (no hay Version/Org/Email/Cloud); Stats sin lista de plugins |
| 20-cmd-permissions | Pestaña `Mode` en lugar de `Auto mode`; sin lista MCP |
| 20-cmd-resume | Lista global (no por proyecto); footer `Ctrl+N …` (no hay Ctrl+A/Ctrl+B) |
| 20-cmd-context | Categorías de Cosmew (Instructions/Messages), sin System prompt/tools medidos |
| 20-cmd-rewind | Solo prompts de la sesión; `⚠ No code restore` (sin checkpoints) |
| 10-ctrl-o | Footer sin `v to open in code` / `? for shortcuts` |
| 20-cmd-mcp/hooks | Panel "Not implemented" (no hay MCP general ni hooks) |
| Variante clara | No capturada: el tema oscuro guardado del usuario gana; cubierta por tests de color |
| Transcript/permiso con modelo | Sin captura (no se envían prompts); cubierto por `reference-frames.test.tsx`, goldens, `fullscreen.test.tsx` |

## Huecos históricos de SDK (P1 los reemplaza)

- Sin fuente de shells en segundo plano (`backgroundShells`, `backgroundCommandNotice`), sin adjuntar imágenes (Ctrl+V),
  `/rewind` y `/hooks` no están en `SLASH_COMMANDS` (no salen en el menú `/`), sin checkpoints de código/conversación.

## Goldens

`golden-ink/integrated-{80,36}.txt`: prompt `❯` con sangría, sin línea en blanco tras el prompt, viñetas `-`, sin etiqueta
de lenguaje en el bloque de código, `Read 1 file` fusionado, `⎿  ☐` con dos espacios. `permission-{80,36}.txt`: resumen
`Running 1 shell command…`, diálogo `Bash command` con `❯ 1. Yes` y `Esc to cancel · Tab to amend`. Snapshot de
`foundation.test.tsx`: Panel con regla `▔`, ListPicker con `❯`, Markdown con `-`.


## P2 — 2026-11-20

Integración por SDK 1.38: backgroundTasks (footer, output/stop y completion durable); queuedInput/retract/send-now;
plan approval explícita; attachImage/chips; checkpoints/rewind; mcpServers agrupados por source y hooks supported:false.
`hook.ran` se conserva en orden y solo se muestra en transcript detallado. Panel diff Current desde 110 columnas,
auto-open tras receipt de edición, viewport reducido y colores medidos. Settings `/` y Space conectados.

No es paridad 100%: faltan bases session/branch en SDK, artifact/path editable del plan y summarize en rewind.
Se muestran razones visibles; no se amplían permisos ni se inventan snapshots. Model/effort session-only, fast mode,
thinking toggle y ámbitos de historia siguen sin API. El clipboard macOS real necesita verificación de host.

Evidencia: `testing/p2-integration.test.tsx`, `features/{composer,background-tasks,plan-approval,panels,diff,transcript}/*test*`,
`picker/v4-dialogs.test.tsx`, `testing/fullscreen.test.tsx` y `testing/native-pty.test.ts`.
La prueba PTY verifica salida real de alternate screen para `[`; `v` ejecuta un editor real sobre copia 0600.
No se regrabaron goldens; se revisan las variantes 80 y 36 con las pruebas existentes.

Auditoría P2 por los ocho puntos, límites SDK y resultados locales: [p2-status.md](p2-status.md). La aprobación con feedback y la retracción selectiva de colas mixtas también necesitan API; no se presentan como completadas.
