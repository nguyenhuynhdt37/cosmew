# Claude Code diff interaction evidence

Inspection date: 2026-11-21 (Asia/Ho_Chi_Minh). Artifact: `/Users/huynh/.local/share/claude/versions/2.1.330`; installed version directory `2.1.330`, embedded source banner `Version: 2.1.330`. Size: 363,855,808 bytes. SHA-256: `f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815`. Upstream source path is the installed artifact; no upstream repository revision was inferred.

This is a read-only static inspection of embedded JavaScript, not observed terminal execution. Python `re` operated on `Path.read_bytes()`; only bounded matched slices were decoded for display. No `strings` or whole-binary `rg` was used. Offsets below are decimal, zero-based, half-open `[start,end)` byte offsets in this exact SHA-256 artifact. Names such as `sc` and `Co` are minified bundle-local names.

## Screenshot follow-up

**Before (Cosmew, 89 files at 110+ columns).** The Current source pane showed grey
paths with coloured counts, no selected-row cue, and an eight-file window whose
only advertised scroll key was Option+Down. The generated-file toggle looked like
another path. A long added line filled a saturated green block and repeated the
change marker on its continuation.

**After.** A tinted row and pointer follow the current file, with separate directory
and filename styles, status markers, and coloured counts. Arrow keys, j/k, page
keys, and Home/End or g/G move through the list. The list keeps two neighbouring
rows in view where space permits and advertises the active bindings. The file
heading shows its position. Wheel events move the file selection over the list and
scroll the patch over the body. A click selects a file and starts its preview at
the first hunk. The generated-file toggle is italic and responds to click or t.
Additions and deletions use panel-based tints with neutral source text and optional
syntax accents. Long lines wrap on grapheme boundaries with a blank continuation
gutter. The shared renderer only mounts the visible body rows in scrollable views.

The live captures in this section come from Claude Code 2.1.328 on 2026-11-19
([capture metadata](spec.md)). The 100-column idle capture records the resize
notice and its terminal-default colour
([text](reference/idle-100x30/20-cmd-diff.txt),
[colours](reference/idle-100x30/20-cmd-diff.colors.json)).
The 120-column live diff capture contains the preceding dark patch receipt and
the toggle notice. It shows green `#50c850` markers, neutral `#f8f8f2` source, and a
muted `#3d423c` added background
([text](reference/live-120x36/L10-diff.txt),
[colours](reference/live-120x36/L10-diff.colors.json)).
The open light pane shows `#248a3d` on `#e4f0da` for additions and `#cf222e`
on `#f7d9d9` for deletions
([text](reference/live-120x36/L02-edit-done.txt),
[colours](reference/live-120x36/L02-edit-done.colors.json)).
Those measurements inform the token-based tints. The status markers, hunk accent,
and highlighted selection are Cosmew choices guided by the screenshot. The selected
row uses reverse video at 16-colour depth, where close background shades can
quantize to the same terminal colour.

## Observed bindings and semantics

| Surface/state | Static observation | Evidence |
|---|---|---|
| `/diff` dispatch | Fullscreen description is “Toggle the diff panel showing uncommitted changes”; inline description is “View uncommitted changes and per-turn diffs”; `immediate` depends on fullscreen. These are distinct surfaces. | E2 |
| Dialog list | Left/Right switches current/per-turn source cyclically when more than one source exists. Up/Down and j/k map to file actions. List-only Select handlers clamp file index. List renders seven visible entries with `wrap:!1`. | E1, E3, E4, E7 |
| Dialog list → detail | `onSelect` changes mode to `detail`. Esc in detail returns to list; Esc in list calls completion with “Diff dialog dismissed”. | E5 |
| Dialog detail | Up/Down and j/k route to `scrollBy(-1/+1)`. PageUp/PageDown use half viewport; Space/Shift+Space/b use full viewport; g/G and Home/End reach edges. Source-switch handlers only act in list mode. | E1, E3, E4 |
| Dialog list footer | Conditional Left/Right “switch source”; Up/Down “select”; Enter “view”; Esc “close”. | E6 |
| Dialog detail footer | Up/Down “scroll”; Esc “back”. The footer does not enumerate all bound paging/edge keys. | E6 |
| Shared Select wheel | When enabled and content does not fit, the widget binds a wheel handler and scrolls one viewport row per wheel sign. It stops immediate propagation. Its viewport `onScroll` adjusts the cursor into the visible range. | E8 |
| Shared Select click | Rendered rows contain click handlers that set the cursor and invoke the accept callback; branches also support cursor-only click behavior and ignore disabled/stray/dropped clicks. | E9 |
| Global wheel bridge | A capture handler converts wheel delta sign to `wheelup`/`wheeldown` and wheel flags, passes modifiers and coordinates through target checks, then dispatches through shared action routing. | E11 |
| Fullscreen diff panel | Its panel handler calls `scrollBy(deltaY*3)`, prevents default, and stops propagation. This is separate from the shared Select wheel handler. | E12 |

## Interpretation and limits

The Dialog file list composes `sc` (E7), the import at `[352916935,352916984)` names `sc` from `/$bunfs/root/chunk-8n6jzsq4.js`, and that shared widget is `Object.assign(wt,{Item:tn,Heading:rn})` (E10). Its visible-count branch delegates to the viewport renderer. Together with E8/E9, this supports an inference that overflowing dialog lists can scroll by wheel and visible file rows can activate by click. Exact event hit testing, focus, terminal mode, accessibility branches, stray-click guards, and layout determine which branch runs: **Needs verification** in a real terminal. A handler present in embedded source does not prove it is active in every mode.

Do not treat wheel events as Up/Down file-selection keystrokes: the artifact exposes separate wheel events and direct viewport handlers. The dialog detail renderer itself (`QPt`, beginning at byte 330040250) has no direct wheel handler in its bounded function body; detail wheel behavior through parent scroll containers is **Needs verification**. E12 proves the separate fullscreen panel has a direct wheel handler; it does not prove the same behavior for the inline dialog. `diff:back` is registered (E4), but no default key for it appears in E1; Esc uses `diff:dismiss` and its state-dependent implementation (E5).

Runtime acceptance remains **Needs verification**: physical wheel/trackpad behavior, click-to-open and source-tab hit testing, terminal mouse modes, paging with changing terminal height, focus after Esc/back, selected-file and scroll-position preservation, and behavior under custom keybindings. No authenticated provider session, external agent process, or Claude executable was launched for this inspection. No Cosmew test or live parity claim follows from these static bytes.

## Bounded source excerpts

Each excerpt is verbatim decoded embedded source; trailing fragments reflect the explicit bound.

### E1 — default DiffDialog bindings

Bytes `[292826650,292827051)` (401 bytes).

```javascript
context:"DiffDialog",bindings:{escape:"diff:dismiss",left:"diff:previousSource",right:"diff:nextSource",up:"diff:previousFile",down:"diff:nextFile",j:"diff:nextFile",k:"diff:previousFile",pageup:"scroll:pageUp",pagedown:"scroll:pageDown",space:"scroll:fullPageDown","shift+space":"scroll:fullPageUp",b:"scroll:fullPageUp",g:"scroll:top","shift+g":"scroll:bottom",home:"scroll:top",end:"scroll:bottom"}
```

### E2 — /diff surface selection

Bytes `[302695805,302696262)` (457 bytes).

```javascript
var bPt={type:"local-jsx",name:"diff",isEnabled:()=>!uto(),get description(){return Spr(Mf()?"fullscreen":"inline")==="fullscreen"?"Toggle the diff panel showing uncommitted changes":"View uncommitted changes and per-turn diffs"},immediate:(e,o)=>Spr(o)==="fullscreen",thinClientDispatch:"control-request"};var wLs={type:"local-jsx",name:"memory",description:"Edit CLAUDE.md files and memory settings",thinClientDispatch:"control-request",...!1},EPt=wLs;var
```

### E3 — detail scroll and source navigation

Bytes `[352927622,352929099)` (1477 bytes).

```javascript
Cd("diff-dialog");let le=rR(),Ze;if(t[15]!==le?.handle||t[16]!==n)Ze=function b(ei){let F=le?.handle;if(n!=="detail"||!F){return!1}let _e=Math.max(1,Math.floor(F.getViewportHeight()/2));let je=Math.max(1,F.getViewportHeight());Oi:switch(ei){case"up":{F.scrollBy(-1);break Oi}case"down":{F.scrollBy(1);break Oi}case"pageUp":{iIe(F,-_e,!1);break Oi}case"pageDown":{iIe(F,_e,!1);break Oi}case"fullPageUp":{iIe(F,-je,!1);break Oi}case"fullPageDown":{iIe(F,je,!1);break Oi}case"top":{F.scrollTo(0);break Oi}case"bottom":{F.scrollToBottom()}}},t[15]=le?.handle,t[16]=n,t[17]=Ze;else Ze=t[17];let b=Ze,et,tt;if(t[18]!==a.length||t[19]!==n)et=()=>{if(n==="list"&&a.length>1)K((ti)=>(ti-1+a.length)%a.length)},tt=()=>{if(n==="list"&&a.length>1)K((ii)=>(ii+1)%a.length)},t[18]=a.length,t[19]=n,t[20]=et,t[21]=tt;else et=t[20],tt=t[21];let ot;if(t[22]!==n)ot=()=>{if(n==="detail")N("list")},t[22]=n,t[23]=ot;else ot=t[23];let st,rt,nt,lt,at,ft,ct,dt;if(t[24]!==b)st=()=>b("up"),rt=()=>b("down"),nt=()=>b("pageUp"),lt=()=>b("pageDown"),at=()=>b("fullPageUp"),ft=()=>b("fullPageDown"),ct=()=>b("top"),dt=()=>b("bottom"),t[24]=b,t[25]=st,t[26]=rt,t[27]=nt,t[28]=lt,t[29]=at,t[30]=ft,t[31]=ct,t[32]=dt;else st=t[25],rt=t[26],nt=t[27],lt=t[28],at=t[29],ft=t[30],ct=t[31],dt=t[32];let ut;if(t[33]===R)ut={context:"DiffDialog"},t[33]=ut;else ut=t[33];gs({"diff:dismiss":B,"diff:previousSource":et,"diff:nextSource":tt,"diff:back":ot,"diff:previousFile":st,"diff:nextFile":rt,"scroll:pageUp":nt,"
```

### E4 — action registration and list-only selection

Bytes `[352928955,352930025)` (1070 bytes).

```javascript
gs({"diff:dismiss":B,"diff:previousSource":et,"diff:nextSource":tt,"diff:back":ot,"diff:previousFile":st,"diff:nextFile":rt,"scroll:pageUp":nt,"scroll:pageDown":lt,"scroll:fullPageUp":at,"scroll:fullPageDown":ft,"scroll:top":ct,"scroll:bottom":dt},ut),ZK("DiffDialog");let mt;if(t[34]!==i.files.length||t[35]!==p)mt=(oi)=>Ke((z)=>{let pt=z.source===p?z.index:0;let ht=Math.max(0,Math.min(i.files.length-1,pt+oi));if(ht===pt){return z}return{source:p,index:ht,mount:z.mount+1}}),t[34]=i.files.length,t[35]=p,t[36]=mt;else mt=t[36];let J=mt,gt;if(t[37]!==J)gt={"diff:previousFile":()=>J(-1),"diff:nextFile":()=>J(1)},t[37]=J,t[38]=gt;else gt=t[38];const ae=n==="list";let Dt;if(t[39]!==ae)Dt={context:"Select",isActive:ae},t[39]=ae,t[40]=Dt;else Dt=t[40];gs(gt,Dt);let xt;if(t[41]!==i.stats)xt=i.stats?o(r,{dimColor:!0,children:[i.stats.filesCount," ",O(i.stats.filesCount,"file")," ","changed"," ",e(fx,{added:i.stats.linesAdded,removed:i.stats.linesRemoved})]}):null,t[41]=i.stats,t[42]=xt;else xt=t[42];let fe=xt,wt=!x&&i.noCommits===!0,si=!x&&i.source.kind==="branch",
```

### E5 — detail back and list activation

Bytes `[352930664,352931693)` (1029 bytes).

```javascript
function B(){if(n==="detail")N("list");else d("Diff dialog dismissed",{display:"system"})}let Y;if(t[48]!==i.files||t[49]!==i.loading||t[50]!==de||t[51]!==U.mount||t[52]!==l?.isBinary||t[53]!==l?.isLargeFile||t[54]!==l?.isRestricted||t[55]!==l?.isTruncated||t[56]!==l?.isUntracked||t[57]!==l?.path||t[58]!==ne||t[59]!==q||t[60]!==p||t[61]!==n)Y=i.files.length===0?i.loading?e(Et,{message:"Loading diff\u2026"}):e(Jn,{children:de}):n==="list"?e(A,{files:i.files,defaultFocusIndex:q,resetKey:p,onFocus:(ri)=>Ke((ni)=>({...ni,source:p,index:ri})),onSelect:()=>N("detail")},U.mount):e(QPt,{filePath:l?.path||"",hunks:ne,isLargeFile:l?.isLargeFile,isBinary:l?.isBinary,isTruncated:l?.isTruncated,isUntracked:l?.isUntracked,isRestricted:l?.isRestricted}),t[48]=i.files,t[49]=i.loading,t[50]=de,t[51]=U.mount,t[52]=l?.isBinary,t[53]=l?.isLargeFile,t[54]=l?.isRestricted,t[55]=l?.isTruncated,t[56]=l?.isUntracked,t[57]=l?.path,t[58]=ne,t[59]=q,t[60]=p,t[61]=n,t[62]=Y;else Y=t[62];let vt;if(t[63]!==fe||t[64]!==Y)vt=o(Q,{children:[fe,Y]}
```

### E6 — exact footer hints

Bytes `[352931793,352932480)` (687 bytes).

```javascript
Z=n==="list"?o(it,{children:[a.length>1&&e(Ee,{chord:["left","right"],action:"switch source"}),e(Ee,{chord:["up","down"],action:"select"}),e(Ee,{chord:"enter",action:"view"}),e(rs,{action:"diff:dismiss",context:"DiffDialog",fallback:"Esc",description:"close"})]}):o(it,{children:[e(Ee,{chord:["up","down"],action:"scroll"}),e(rs,{action:"diff:dismiss",context:"DiffDialog",fallback:"Esc",description:"back"})]}),t[66]=a.length,t[67]=n,t[68]=Z;else Z=t[68];const pe=a.length<=1,he=String(p);let kt;if(t[69]===R)kt=(ai)=>K(Number(ai)),t[69]=kt;else kt=t[69];const ge=n==="detail";let _;if(t[70]!==me||t[71]!==a)_=a.map((Ft,Tt)=>e(Su,{id:String(Tt),title:Ft.type==="current"?"Current":`T${F
```

### E7 — list composition

Bytes `[352924510,352925292)` (782 bytes).

```javascript
var De=7;function A(T){let u=k(9),{files:s,defaultFocusIndex:d,resetKey:t,onFocus:c,onSelect:h}=T;if(s.length===0){let m;if(u[0]===R)m=e(Jn,{children:"No changed files"}),u[0]=m;else m=u[0];return m}let m;if(u[1]!==s)m=s.map(Nt),u[1]=s,u[2]=m;else m=u[2];let n;if(u[3]!==d||u[4]!==c||u[5]!==h||u[6]!==t||u[7]!==m)n=e(sc,{visibleCount:De,defaultFocusIndex:d,resetKey:t,onFocus:c,onSelect:h,onUpFromFirstItem:Rt,wrap:!1,children:m}),u[3]=d,u[4]=c,u[5]=h,u[6]=t,u[7]=m,u[8]=n;else n=u[8];return n}function te(T){let c=k(11),{file:s}=T,d=oW();const t=d?"suggestion":void 0;let h;if(c[0]!==s.path)h=FP(s.path),c[0]=s.path,c[1]=h;else h=c[1];let u;if(c[2]!==t||c[3]!==h)u=e(g,{flexBasis:0,flexGrow:1,marginRight:1,children:e(r,{color:t,wrap:"truncate-start",children:h})}),c[2]=t,c[3]=h,c
```

### E8 — shared Select viewport wheel

Bytes `[325395450,325396420)` (970 bytes).

```javascript
function xo(i){if(i.deltaY===0||Mte(W))return;K.scrollBy(i.deltaY>0?1:-1),i.stopImmediatePropagation()}function ko(i,v=!1){if(!v&&Mte(W))return;K.scrollTo(i<0?0:T)}function Je(i){K.pin(),Y(Du(i,0,D))}return{cursor:C,windowStart:K.windowStart,windowEnd:K.windowEnd,spareLines:K.spareLines,moreAbove:re[K.windowStart]??0,moreBelow:n-(re[K.windowEnd]??n),getCursor:U,isCursor:(i)=>i===C&&n>0,hasFocus:te,scrollBar:{...K.bar,onScrollTo:N?void 0:K.bar.onScrollTo,onScrollBy:N?void 0:K.bar.onScrollBy},setCursor:Je,scrollToEdge:ko,containerRef:b,bind:{ref:b,tabIndex:0,onKeyDown:ce,onWheel:!N&&!K.fits?xo:void 0}}}function Mte(n){return typeof n==="function"?n():n===!0}G();function J1e(n){let t=I(null),s=MF(),a=qe(),c=be(Rb),m=be(c_e),d=c===null?m:null,E=c===null?a.rows:s?.rows??c.rows;function W(){let f=t.current,A=s?.box.current??(d&&f);if(f===null||s!==null&&s.box.current===null)return null;let O=Number.POSITIVE_INFINITY,b=0;while(f!==A&&f.parentNode!==void 0){b+=ir(
```

### E9 — shared Select click handlers

Bytes `[325402179,325403004)` (825 bytes).

```javascript
let Ee=q[Kt]??0;let Vt=B.isCursor(Ee);return e(bo.Provider,{value:Vt&&!ee,children:e(g,{flexDirection:"column",height:u[Ee],overflow:"hidden",onClick:ee&&x!==void 0?(_t)=>{if(_t.droppedAsStray||Je(_t)){return}B.setCursor(Ee),x(Ee)}:C==="move"&&!ee&&d!==void 0?($t)=>{if($t.droppedAsStray||Je($t)||Mte(h)){return}B.setCursor(Ee)}:void 0,children:e(kp,{isFocused:Vt,idle:ee,showScrollUp:ve==="glyph"&&zt,showScrollDown:ve==="glyph"&&gn,styled:P,hoverStyle:D,declareCursor:!ee&&nn(Te)?.declareCursor!==!1,onClick:ee||d===void 0||C==="move"?void 0:(hi)=>{if(Je(hi)||Mte(h)){return}B.setCursor(Ee),d(Ee)},children:Te})})},Ut)}),V;if(K[8]!==B.spareLines)V=B.spareLines>0&&e(g,{flexShrink:0,height:B.spareLines}),K[8]=B.spareLines,K[9]=V;else V=K[9];let Ke=V;if(!Q){let J;if(K[10]!==Qe||K[11]!==Ze||K[12]!==B.bind||K[13]!==Ae||K[14]
```

### E10 — Select identity/import chain

Bytes `[325404601,325404694)` (93 bytes).

```javascript
var sc=Object.assign(wt,{Item:tn,Heading:rn});function si(){return new Set}function li(Z){if(
```

### E11 — mouse wheel capture bridge

Bytes `[312642652,312643354)` (702 bytes).

```javascript
K=(a)=>{if(Ut(a.target,a.currentTarget,a.col,a.row))return;let u={name:a.deltaY<0?"wheelup":"wheeldown",key:"",ctrl:a.ctrl,shift:a.shift,meta:a.meta,superKey:!1},p={upArrow:!1,downArrow:!1,leftArrow:!1,rightArrow:!1,pageDown:!1,pageUp:!1,wheelUp:a.deltaY<0,wheelDown:a.deltaY>0,home:!1,end:!1,return:!1,escape:!1,tab:!1,backspace:!1,delete:!1,ctrl:a.ctrl,shift:a.shift,meta:a.meta,super:!1};W(a,u,"",p,"",()=>ot(a))},S=I(null);return It(()=>{if(!S.current)return;let a=cH(S.current),u=()=>{let p=S.current;if(!p||a.activeElement===p)return;if(a.activeElement===null){a.focus(p);return}let v=p.parentNode;while(v){if(v===a.activeElement){a.focus(p);return}v=v.parentNode}};return u(),a.subscribe(u)},[])
```

### E12 — fullscreen diff panel wheel

Bytes `[330051934,330052206)` (272 bytes).

```javascript
bi=(Ka)=>{Co.handle?.scrollBy(Ka.deltaY*3),Ka.preventDefault(),Ka.stopPropagation()},Bt[44]=Co.handle,Bt[45]=bi;else bi=Bt[45];const ia=!0;let bl;if(Bt[46]!==Ra||Bt[47]!==is||Bt[48]!==ft||Bt[49]!==Vr||Bt[50]!==Fr)bl=!ft&&Ra===null&&o(r,{children:[o(r,{bold:!0,children:[is
```


## Cosmew implementation and component audit

The implementation uses Cosmew's existing central `DiffDialog` actions, with new
`DiffPanel.diff:focus` (Tab) and `diff:blur` (Esc) actions. Footers subscribe to the
current user keymap; `?` and `/help` publish the focus, source, file/open and paging
actions. These names are not all identical to Claude Code's embedded action names
above. PageUp/PageDown move half a viewport; Space/B/Shift+Space a full viewport;
Home/End and g/G reach the edges. Plain arrows/j/k select files in list mode and
scroll in detail mode. Existing Ctrl/Meta arrows and Ctrl+X B remain available.

Opening `/diff` keeps the draft active. Tab deliberately focuses the side pane;
Escape backs out of detail, then returns to the preserved draft. The panel close
button closes the pane. Left/right source traversal respects SDK capabilities and
reports unavailable bases. Scoped wheel moves only the diff underneath the pointer;
click selects a visible file, cycles source, or closes via ✕. Ordinary list/option
clicks highlight only; explicit keyboard activation still confirms permission,
plan approval and rewind. This deliberate focus-only choice differs from upstream
Select's possible click-accept branch (E9).

A repository-wide consumer search covered `Diff`, `DiffView`, `ToolDiff`,
`ListPicker`, `PanelTabs`, `OptionList`, `SearchBox`, and `Pointer`.

| Component / path under `apps/tui/src/ink` | Changed or checked | Result / reason |
| --- | --- | --- |
| `features/diff/index.tsx`: `useDiff`, `Diff` | Changed | Hidden session invalidation no longer launches competing refresh; consent changes still refresh and generation/session checks still reject stale results. Standalone Diff gains clickable file rows/source, scoped wheel, bounded detail scrolling, correct list/detail arrows and current key hints. |
| `features/diff/panel.tsx`: `DiffSidePanel` | Changed | Deliberate focus/blur, direction-aware sources, file/source/close targets, scoped wheel, detail arrows, half/full paging and fixed-height nonshrinking controls. |
| `integrated-shell.tsx` | Changed | Owns panel focus, disables composer/transcript shortcuts while pane owns input, excludes pane coordinates from transcript wheel; focus resets on close/resize. |
| `hooks/keymap/{defaults,help,react}.tsx/ts` | Changed | Central actions, help entries, live binding labels. No private package imports. |
| `hooks/use-terminal-wheel.tsx`, `../input/mouse-input.ts` | Changed | Separate optional left-click subscription; existing wheel-only API/lifecycle retained. Hit testing accounts for coordinates, offsets, clipping, hidden/inactive scopes. No extra stdin reader. |
| `ui/mouse-row.tsx` | Added | Measured wrapped-row click region; rows cannot collapse in fixed-height parents. |
| `ui/list-picker.tsx` | Changed | Bounded wheel highlight, row-click highlight; filtering, disabled-item guard, Enter activation and keymap retained. |
| `ui/option-list.tsx` | Changed | Optional active/cursor/wheel callbacks; full wrapped descriptions are clickable; no click approval. |
| `ui/panel-tabs.tsx` | Changed | Measured tab click targets; title/gaps ignored, narrow tab rows wrap. Existing feature keyboard actions remain authoritative. |
| `features/picker/index.tsx`: `Detail`, `Tabs` | Changed | Detail wheel scrolls only output; Tabs forwards callbacks. `PickerDialog`/`Dialog` already forward shared controls. |
| `features/panels/index.tsx`: `RewindDialog`, `McpDialog` | Changed | Checkpoint and MCP row click/wheel; rewind scope options highlight before explicit Enter. Rewind scope/summary text and operation policy retained. |
| `features/plan-approval/index.tsx`: `PlanApprovalDialog` | Changed | Proposal body wheel and choice highlighting; Enter remains approval. Keyboard paging and revision/proposal checks retained. |
| `features/permissions/index.tsx`: request/rules dialogs, `EditPreview` | Changed | Choices highlight by mouse, rule tabs clickable; diff preview now pages and wheels instead of permanently hiding rows beyond the preview bound. No approval from mouse. |
| `features/question/index.tsx` | Changed | Clickable question tabs and option highlighting; split lists share wheel navigation. Text answer and submission remain explicit. |
| `features/{help,settings,sandbox}/index.tsx` | Changed | Tab callbacks, shared list/option cursor callbacks, busy guards. Read-only reports remain display-only. |
| `features/background-tasks/index.tsx` | Checked; source unchanged | Inherits ListPicker wheel/row selection and Detail output scrolling. Enter opens output, Esc backs out, x explicitly stops; no mouse-triggered stop added. |
| `features/{sessions,themes,models,connect,memory,agents,skills}` | Checked; source unchanged | Existing direct ListPicker or PickerDialog/Detail consumers inherit scoped mouse behavior; existing filtering and central keyboard actions retained. |
| `features/panels`: `HooksDialog`, report/context panels | Checked; unchanged portions | Read-only/unsupported snapshots have no choices to activate. Tabbed host report routes use SettingsDialog callbacks. |
| `ui/search-box.tsx` | Checked; unchanged | Presentation of query owned by ListPicker; typing, deletion, filtering and keyboard focus already belong to its parent. No independent focus trap introduced. |
| `ui/pointer.tsx`, `features/autocomplete/index.tsx` | Checked; unchanged | Pointer only paints a marker, with no input ownership. Composer completion has its own central Autocomplete keyboard context and Tab acceptance; it is not a diff/list panel. Mouse row highlighting was confined to shared panel controls rather than changing composer completion/text-entry semantics. |
| `ui/diff.tsx`: `DiffView`, `features/diff`: `ToolDiff`, transcript receipts | Shared renderer | File previews, edit approval, and diff fences share line styling and wrapping. Scrollable callers supply a viewport. Transcript owns receipt scrolling, expansion, and terminal-native text selection. |
| `features/composer`, external plan editor in `integrated-shell.tsx` | Checked; editor logic unchanged | Terminal suspension already disables/restores mouse modes; external editor owns its input. Existing plan-editor tests cover edited content and stale proposal revisions. |
| `features/commands.ts` `/review`, SDK `reviewEvidence`/`refreshWorkspaceDiff` | Checked; unchanged | Review waits for policy-filtered evidence and checks session/message/model/mode/abort before submission. **Current Cosmew does not open/embed a Diff dialog from /review**: it starts the read-only review turn; inspection failure points to `/diff`. `/diff` in IntegratedShell toggles the side pane (narrow terminals retain the documented resize notice). Standalone `Diff` is currently a reusable/tested component, not an additional production overlay route. |

The consumer audit above describes the current wiring rather than claiming that a
review-specific dialog exists. No new SDK/event contract, dependency or provider
runtime was added. Shared permission/plan choices continue to require explicit
confirmation after mouse highlighting.

## Review cancellation regression

The end-to-end test replaces `client.refreshWorkspaceDiff` with a deferred promise
and retains its resolver. On a session switch, `useDiff.reconcile` previously
launched an unrelated second refresh even with the pane hidden. That replaced the
test's retained resolver; completing it settled the pane request and left the
review command awaiting the original request, so `Review cancelled` never rendered.
The hidden pane now invalidates its generation and reads the current SDK report
without launching a session-only refresh. A visible pane or consent transition can
still refresh; SDK consent checks and hook generation/session guards remain.
A port-free integrated-shell regression asserts there is exactly one refresh,
then resolves it and checks the cancelled notice, chat mode and empty active session.

## Validation from the earlier interaction pass (2026-11-21)

Commands were run sequentially, not as concurrent test processes. No goldens or
snapshots were updated. No stash/reset/commit/stage/unstage operation was performed
on the coordinator working tree.

| Check | Observed result |
| --- | --- |
| `bun run typecheck` | Passed after final source/test changes. |
| `bun run lint` | Passed: unused checks, repository Prettier check, `git diff --check`. |
| `bun test apps/tui/src/ink/features/diff apps/tui/src/ink/hooks/keymap` | 46 pass, 2 existing FORCE_COLOR-dependent skips, 0 fail. Includes 29 diff tests and 17 central keymap tests. |
| `bun test apps/tui/src/ink/features/picker apps/tui/src/ink/ui/mouse-controls.test.tsx` | 75 pass, 0 fail. Includes added permission-preview paging/wheel safety and shared control mouse tests. |
| `bun test apps/tui/src/ink/features/background-tasks` | 2 pass, 0 fail. |
| `bun test apps/tui/src/ink/features/panels` | 11 pass, 0 fail; contains rewind/checkpoint tests. |
| `bun test apps/tui/src/ink/features/plan-approval` | 9 pass, 0 fail; includes wheel and click-without-approval sequence. |
| `bun test apps/tui/src/ink/testing/*.test.tsx` | 120 pass, 0 fail; 6 snapshots passed unchanged. This run preceded the final additional key-remap test below. |
| `bun test apps/tui/src/ink/testing/p2-integration.test.tsx` | Final rerun: 12 pass, 0 fail, including hidden-review cancellation, Tab/detail/Esc draft preservation and live user-remapped focus/blur/footer. |
| `bun test apps/tui/src/input` | 13 pass, 0 fail. Includes SGR/X10 lifecycle, split/coalesced reports, paste/string isolation and separate plain left-click events. |
| `bun test tests/end-to-end/tui-modes.test.ts` | Blocked at fixture setup: `Bun.serve` listen `EADDRINUSE` on port 0 (10 fixture-dependent tests fail before their behavior assertions; 1 port-free test passes). Coordinator must rerun. |
| `bun test tests/end-to-end/tui-ink-pty.test.ts --test-name-pattern 'Ink diff PTY at 140 columns'` | Blocked at the same fixture-server bind before launching the CLI; 1 setup failure, 6 unrelated tests filtered out. Coordinator must run the added real-fyn case. |

The PTY case uses a disposable Git repository and sends Tab, file arrows/j/k,
Enter/Esc, and literal SGR click/wheel reports at 140 columns, checking file, detail,
source, close, prompt and terminal-mode teardown behavior. Its end-to-end assertions
are **Needs verification** because this sandbox cannot bind the required fixture port.
The full suite is reserved for the coordinator. Physical mouse/trackpad behavior and
native text selection across terminal emulators remain **Needs verification**.

## Screenshot follow-up verification

- Typecheck and lint passed. The diff suite passed 46 tests, and both
  FORCE_COLOR-gated diff tests passed in a separate truecolour run.
- Picker passed 70 tests, plan approval passed 10, and background tasks passed 2.
  Ink testing passed 127 tests and six snapshots. The synthetic native PTY passed
  separately. Shared mouse controls and rewind/checkpoint coverage passed 16 tests.
- The extended 140-column CLI PTY case pages and wheels beyond the initial
  file window and checks the selected row and first hunk. **Needs verification**.
  Its fixture server returned `EADDRINUSE` binding port 0 before the CLI launched.
- The existing snapshot changes for the shared diff gutter were reviewed against
  the rendered frames. This pass did not re-record snapshots or goldens.
