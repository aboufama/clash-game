import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/components/TrainingModal.tsx', import.meta.url),
  'utf8',
)

const sliceBetween = (start, end, label) => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Could not isolate ${label}`)
  return source.slice(startIndex, endIndex)
}

assert.match(source, /const TROOP_TOOLTIP_DELAY_MS = 1_500;/,
  'Troop detail must require the full 1.5-second deliberate hover/focus')

const lifecycle = sliceBetween('  useEffect(() => {', '  if (!isOpen) return null;', 'tooltip lifecycle')
assert.match(source, /if \(tooltipOpenState !== isOpen\) \{[\s\S]*?setTooltipOpenState\(isOpen\);[\s\S]*?setTooltip\(null\);/,
  'A modal session change must clear stale render-owned tooltip detail')
assert.match(lifecycle, /if \(!isOpen\) \{[\s\S]*?window\.clearTimeout\(tooltipTimer\.current\)[\s\S]*?tooltipCandidate\.current = null;/,
  'Closing the modal must cancel pending tooltip work')
assert.match(lifecycle, /return \(\) => \{[\s\S]*?window\.clearTimeout\(tooltipTimer\.current\)/,
  'Unmounting the modal must cancel the pending tooltip timer')

const queue = sliceBetween('  const queueTooltip =', '  const cancelTooltip =', 'tooltip scheduler')
assert.match(queue, /window\.clearTimeout\(tooltipTimer\.current\)/,
  'A new candidate must cancel the previous tooltip timer')
assert.match(queue, /tooltipCandidate\.current = troopId;[\s\S]*?setTooltip\(null\);[\s\S]*?window\.setTimeout/,
  'Changing candidates must hide stale detail before starting the next delay')
assert.match(queue, /tooltipTimer\.current = null;[\s\S]*?if \(tooltipCandidate\.current !== troopId\) return;[\s\S]*?setTooltip\(pending\);/,
  'A stale timer must not reveal the wrong troop')
assert.match(queue, /}, TROOP_TOOLTIP_DELAY_MS\);/,
  'The scheduler must use the shared deliberate-hover delay')

const cancel = sliceBetween('  const cancelTooltip =', '  const showLockPopup =', 'tooltip cancellation')
assert.match(cancel, /window\.clearTimeout\(tooltipTimer\.current\)[\s\S]*?tooltipTimer\.current = null;[\s\S]*?tooltipCandidate\.current = null;[\s\S]*?setTooltip\(null\);/,
  'Leave and blur must synchronously clear pending and visible tooltip state')

for (const [event, handler] of [
  ['onMouseEnter', /onMouseEnter=\{\(event\) => !isLocked && queueTooltip\(troop\.id, event\.currentTarget\)\}/],
  ['onMouseLeave', /onMouseLeave=\{cancelTooltip\}/],
  ['onFocus', /onFocus=\{\(event\) => !isLocked && queueTooltip\(troop\.id, event\.currentTarget\)\}/],
  ['onBlur', /onBlur=\{cancelTooltip\}/],
]) {
  assert.match(source, handler, `${event} must remain wired to delayed tooltip scheduling/cancellation`)
}

assert.match(source, /aria-describedby=\{tooltip\?\.id === troop\.id \? 'training-troop-tooltip' : undefined\}/,
  'Only the card owning the visible tooltip may reference it')
assert.match(source, /id="training-troop-tooltip"[\s\S]*?role="tooltip"/,
  'The delayed detail must expose a stable accessible tooltip relationship')
assert.doesNotMatch(source, /className="faction-troop-level-badge"[\s\S]{0,240}?\btitle=/,
  'The troop-level badge must not bypass the deliberate delay with a native title tooltip')
assert.match(source, /id="training-troop-tooltip"[\s\S]*?troopLevelUpgrading[\s\S]*?Troops fight at level 1 while the laboratory is upgrading\./,
  'Lab-upgrade detail must live inside the delayed troop tooltip')

console.log('training tooltip regression: delay, cancellation, stale-candidate, and accessibility checks passed')
