/** Icon and colour for each Canvas item kind (design handoff §3). */

import { IconFileText, IconHierarchy2, IconPhoto, IconTable } from '@tabler/icons-react'
import type { CanvasItemKind } from '../../types'

const ICONS = {
  markdown: { Icon: IconFileText, className: 'text-ink-muted' },
  table: { Icon: IconTable, className: 'text-secondary-5' },
  diagram: { Icon: IconHierarchy2, className: 'text-warning-5' },
  image: { Icon: IconPhoto, className: 'text-ink-muted' },
} satisfies Record<CanvasItemKind, unknown>

export function KindIcon({ kind, size = 16 }: { kind: CanvasItemKind; size?: number }) {
  const { Icon, className } = ICONS[kind]
  return <Icon size={size} stroke={1.75} className={`shrink-0 ${className}`} aria-hidden />
}
