import { useEffect, useState, type RefObject } from 'react'
import { formatValue } from '../../copy'
import { ResultIcon } from '../ResultPanel/ResultIcon'
import type { SceneLabel } from './labels'
import './sceneLabels.css'

type Elements = RefObject<(HTMLDivElement | null)[]>

/** A label's words: the result icon, the text, and the second line under it if it has one. */
function LabelText({ label }: { label: SceneLabel }) {
  return (
    <>
      {label.icon && <ResultIcon result={label.icon} />}
      {label.detail ? (
        <span className="scene-label-lines">
          <span>{label.text}</span>
          <span className="scene-label-detail">{label.detail}</span>
        </span>
      ) : (
        label.text
      )}
    </>
  )
}

const labelClass = (label: SceneLabel) =>
  ['scene-label', label.muted ? 'scene-label-muted' : '', label.icon ? `scene-label-result scene-label-${label.icon}` : '']
    .filter(Boolean)
    .join(' ')

/** The label elements, laid over the canvas. LabelProjector positions and fades them. */
export function SceneLabels({ labels, elements }: { labels: SceneLabel[]; elements: Elements }) {
  return (
    <div className="scene-labels">
      {labels.map((label, i) => (
        <div
          key={label.key}
          ref={(el) => {
            elements.current[i] = el
          }}
          className={labelClass(label)}
          style={{ opacity: 0 }}
        >
          <LabelText label={label} />
        </div>
      ))}
    </div>
  )
}

/**
 * The same labels on a phone (layout.ts, compact), where none floats: the building fills the screen
 * there, and its six home labels and the result's label covered it and each other. The result's
 * label is pinned to the top left corner under the search bar. The homes fold into a list that opens
 * from a button in the other corner, named by how many there are. The note about the scenario sits
 * at the bottom, just above the result sheet. LabelProjector still brings each in on its step of the
 * sequence: the button with the first home's label.
 *
 * Drawn beside the scene, not inside it: the scene is hidden from screen readers, and a button must
 * not be.
 */
export function PinnedLabels({ labels, elements, visible }: { labels: SceneLabel[]; elements: Elements; visible: boolean }) {
  const [open, setOpen] = useState(false)
  // Another design or another lot starts with the list shut, and so does the scene when it comes back.
  const [seen, setSeen] = useState(labels)
  if (seen !== labels) {
    setSeen(labels)
    setOpen(false)
  }
  if (!visible && open) setOpen(false)

  // A tap anywhere else shuts the list.
  useEffect(() => {
    if (!open) return
    const shut = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.scene-homes')) setOpen(false)
    }
    document.addEventListener('pointerdown', shut)
    return () => document.removeEventListener('pointerdown', shut)
  }, [open])

  const indexed = labels.map((label, index) => ({ label, index }))
  const result = indexed.find(({ label }) => label.appear.step === 'fail')
  const note = indexed.find(({ label }) => label.appear.step === 'oldHouse')
  const homes = indexed.filter(({ label }) => label.appear.step === 'labels')
  const place = (index: number) => (el: HTMLDivElement | null) => {
    elements.current[index] = el
  }
  const hidden = { opacity: 0, visibility: 'hidden' } as const

  return (
    <div className={visible ? 'scene-pins scene-pins-visible' : 'scene-pins'}>
      <div className="scene-pins-top">
        {result && (
          <div ref={place(result.index)} className={labelClass(result.label)} style={hidden}>
            <LabelText label={result.label} />
          </div>
        )}
        {homes.length > 0 && (
          <div ref={place(homes[0].index)} className="scene-homes" style={hidden}>
            <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
              <summary>{formatValue(homes.length, 'units')}</summary>
              <ul className="scene-homes-list">
                {homes.map(({ label }) => (
                  <li key={label.key}>{label.text}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </div>
      {note && (
        <div ref={place(note.index)} className={`${labelClass(note.label)} scene-pin-note`} style={hidden}>
          <LabelText label={note.label} />
        </div>
      )}
    </div>
  )
}
