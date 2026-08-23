# Criteria reference

Every field `.where()` accepts, per model, generated from the table the
compiler matches against. A field is a key in a criteria object, holding a
value to match exactly or an object of operators.

```ts
snapshot.panes.where({ currentCommand: { startsWith: "v" } });
```

A field marked with a release arrived in that tmux. Filtering on one an
older server predates raises `VersionTooLow` naming the field, the release
that has it, and the release running — rather than matching nothing, which
reads as "no member has this" and is a different answer.

The vocabulary tracks tmux rather than the Python library this package
ports, so a field tmux has is a field you can filter on. What is left out
is what does not describe an object: `#{host}` is the machine, and
`#{sixel_support}` is how tmux was built. `displayMessage` expands any
format tmux knows, including those:

```ts
await snapshot.panes.one().displayMessage("#{host}");
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

`activeWindowIndex` · `active` (3.6+) · `activityFlag` (3.6+) · `activity` · `alert` (3.6+) · `alerts` · `attachedList` · `attached` · `bellFlag` (3.6+) · `created` · `format` · `groupAttachedList` · `groupAttached` · `groupList` · `groupManyAttached` · `groupSize` · `group` · `grouped` · `id` · `lastAttached` · `lastWindowIndex` · `manyAttached` · `marked` · `name` · `path` · `sessionWindows` · `silenceFlag` (3.6+) · `stack`

Relations:

- `activePane` — `is`, `isNot` over panes
- `activeWindow` — `is`, `isNot` over windows
- `panes` — `some`, `every`, `none` over panes
- `windows` — `some`, `every`, `none` over windows

## Window

`activeClientsList` · `activeClients` · `activeSessionsList` · `activeSessions` · `active` · `activityFlag` · `activity` · `bellFlag` · `bigger` · `cellHeight` · `cellWidth` · `endFlag` · `flags` · `format` · `height` · `id` · `index` · `lastFlag` · `layout` · `linkedSessionsList` · `linked` · `markedFlag` · `name` · `offsetX` · `offsetY` · `rawFlags` · `silenceFlag` · `stackIndex` · `startFlag` · `visibleLayout` · `width` · `windowLinkedSessions` · `windowPanes` · `zoomedFlag`

Relations:

- `activePane` — `is`, `isNot` over panes
- `linkedSessions` — `some`, `every`, `none` over sessions
- `panes` — `some`, `every`, `none` over panes
- `session` — `is`, `isNot` over sessions

## Pane

`active` · `alternateOn` · `alternateSavedX` · `alternateSavedY` · `atBottom` · `atLeft` · `atRight` · `atTop` · `bg` · `bottom` · `bracketPasteFlag` (3.7+) · `currentCommand` · `currentPath` · `cursorBlinking` (3.6+) · `cursorCharacter` · `cursorColour` (3.6+) · `cursorFlag` · `cursorShape` (3.6+) · `cursorVeryVisible` (3.6+) · `cursorX` · `cursorY` · `deadSignal` (3.3+) · `deadStatus` · `deadTime` (3.3+) · `dead` · `fg` · `flags` (3.7+) · `floatingFlag` (3.7+) · `format` · `height` · `historyAllBytes` · `historyBytes` · `historyLimit` · `historySize` · `id` · `inMode` · `index` · `inputOff` · `insertFlag` · `keyMode` (3.5+) · `keypadCursorFlag` · `keypadFlag` · `last` · `left` · `markedSet` · `marked` · `mode` · `mouseAllFlag` · `mouseAnyFlag` · `mouseButtonFlag` · `mouseSgrFlag` · `mouseStandardFlag` · `originFlag` · `path` · `pbProgress` (3.7+) · `pbState` (3.7+) · `pid` · `pipePid` (3.7+) · `pipe` · `right` · `scrollRegionLower` · `scrollRegionUpper` · `searchString` · `startCommand` · `startPath` · `synchronizedOutputFlag` (3.7+) · `synchronized` · `tabs` · `title` · `top` · `tty` · `unseenChanges` (3.4+) · `width` · `wrapFlag` · `x` (3.7+) · `y` (3.7+) · `z` (3.7+) · `zoomedFlag` (3.7+)

Relations:

- `session` — `is`, `isNot` over sessions
- `window` — `is`, `isNot` over windows

## Client

`activity` · `cellHeight` · `cellWidth` · `clientSession` · `controlMode` · `created` · `discarded` · `flags` · `height` · `keyTable` · `lastSession` · `modeFormat` · `name` · `pid` · `prefix` · `readonly` · `termfeatures` · `termname` · `termtype` · `tty` · `uid` · `user` · `utf8` · `width` · `written`

Relations:

- `pane` — `is`, `isNot` over panes
- `session` — `is`, `isNot` over sessions
- `window` — `is`, `isNot` over windows
