# Criteria reference

Every field `.where()` accepts, per model, generated from the table the
compiler matches against. A field is a key in a criteria object, holding a
value to match exactly or an object of operators.

```ts
snapshot.panes.where({ currentCommand: { startsWith: "v" } });
```

## Operators

A scalar field takes these operators:

`contains` · `endsWith` · `equals` · `in` · `mode` · `notIn` · `regex` · `startsWith`

Several on one field must all hold. `mode` takes `"insensitive"` and folds
case for the others rather than matching on its own, and `regex` takes
`{ pattern, flags }` with `flags` one of `""`, `"m"`, `"s"` or `"ms"`.

`AND`, `OR` and `NOT` each take an array of criteria for the same model.

A relation takes a quantifier rather than an operator: `some`, `every` or
`none` where it holds many, and `is` or `isNot` where it holds one.

A name that is not one of these is refused, and the refusal names the
position, lists the vocabulary that was expected, and suggests the nearest
match.

## Session

`activeWindowIndex` · `activity` · `alerts` · `attached` · `attachedList` · `created` · `format` · `group` · `groupAttached` · `groupAttachedList` · `groupList` · `groupManyAttached` · `groupSize` · `grouped` · `id` · `lastAttached` · `lastWindowIndex` · `manyAttached` · `marked` · `name` · `path` · `sessionWindows` · `stack`

Relations:

- `activePane` — `is`, `isNot` over panes
- `activeWindow` — `is`, `isNot` over windows
- `panes` — `some`, `every`, `none` over panes
- `windows` — `some`, `every`, `none` over windows

## Window

`active` · `activeClients` · `activeClientsList` · `activeSessions` · `activeSessionsList` · `activity` · `activityFlag` · `bellFlag` · `bigger` · `cellHeight` · `cellWidth` · `endFlag` · `flags` · `format` · `height` · `id` · `index` · `lastFlag` · `layout` · `linked` · `linkedSessionsList` · `markedFlag` · `name` · `offsetX` · `offsetY` · `rawFlags` · `silenceFlag` · `stackIndex` · `startFlag` · `visibleLayout` · `width` · `windowLinkedSessions` · `windowPanes` · `zoomedFlag`

Relations:

- `activePane` — `is`, `isNot` over panes
- `linkedSessions` — `some`, `every`, `none` over sessions
- `panes` — `some`, `every`, `none` over panes
- `session` — `is`, `isNot` over sessions

## Pane

`active` · `alternateSavedX` · `alternateSavedY` · `atBottom` · `atLeft` · `atRight` · `atTop` · `bg` · `bottom` · `bracketPasteFlag` · `currentCommand` · `currentPath` · `cursorCharacter` · `cursorFlag` · `cursorX` · `cursorY` · `dead` · `deadSignal` · `deadStatus` · `deadTime` · `fg` · `flags` · `floatingFlag` · `format` · `height` · `historyBytes` · `historyLimit` · `historySize` · `id` · `inMode` · `index` · `inputOff` · `insertFlag` · `keypadCursorFlag` · `keypadFlag` · `last` · `left` · `marked` · `markedSet` · `mode` · `mouseAllFlag` · `mouseAnyFlag` · `mouseButtonFlag` · `mouseSgrFlag` · `mouseStandardFlag` · `originFlag` · `path` · `pbProgress` · `pbState` · `pid` · `pipe` · `pipePid` · `right` · `scrollRegionLower` · `scrollRegionUpper` · `searchString` · `startCommand` · `startPath` · `synchronized` · `synchronizedOutputFlag` · `tabs` · `title` · `top` · `tty` · `width` · `wrapFlag` · `x` · `y` · `z` · `zoomedFlag`

Relations:

- `session` — `is`, `isNot` over sessions
- `window` — `is`, `isNot` over windows

## Client

`activity` · `cellHeight` · `cellWidth` · `clientSession` · `controlMode` · `created` · `discarded` · `flags` · `height` · `keyTable` · `lastSession` · `modeFormat` · `name` · `pid` · `prefix` · `readonly` · `termfeatures` · `termname` · `termtype` · `tty` · `uid` · `user` · `utf8` · `width` · `written`

Relations:

- `pane` — `is`, `isNot` over panes
- `session` — `is`, `isNot` over sessions
- `window` — `is`, `isNot` over windows
