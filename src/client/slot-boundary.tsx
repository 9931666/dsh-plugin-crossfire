/**
 * Render-failure boundary for the Crossfire slot entries.
 *
 * WHY THIS EXISTS: DSH retires a slot entry that throws during render
 * (`onEntryError` + abdication) —— 隔离本身是对的，但对用户来说就是"针锋的
 * 设置页根本不存在"，且任何地方都没有提示。那种静默消失正是最难从外部诊断的
 * 故障形态。
 *
 * 给每个 entry 套一层 boundary，就把"崩溃"变成一块写明错误的可读面板，同时把
 * 同样的信息（含组件栈）镜像到浏览器控制台。boundary 刻意不渲染自己的任何数据，
 * 因此它不可能成为第二个故障源；刷新后 React 一旦渲染出健康树，面板即被换掉。
 *
 * @module dsh-plugin-crossfire/client/slot-boundary
 */

import { Component, createElement, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

/** The inject face every Crossfire slot entry receives (see client/index.ts). */
export interface SlotEntryFace {
  /** Locale-bound translator for the `crossfire` namespace. */
  t?: (key: string) => string
}

interface SlotBoundaryProps {
  title: string
  hint: string
  children?: ReactNode
}

interface SlotBoundaryState {
  error: Error | null
}

/** Class-component boundary (React only catches render errors in class components). */
export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SlotBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Second copy on purpose: the panel may be off-screen or localized, while
    // the console line is what a reporter can copy into an issue.
    console.error('[crossfire] slot entry render failed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    // 令牌名以运行时 Theme.listTokens 为准（`--dsw-alias-*`）。圆桌那份写的是
    // `--dsh-*`，那个变量并不存在，实际一直在吃 fallback 颜色；这里修正。
    return createElement(
      'div',
      {
        style: {
          margin: '16px',
          padding: '14px 16px',
          border: '1px solid var(--dsw-alias-state-error-primary, #d9534f)',
          borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(217, 83, 79, 0.06))',
          color: 'var(--dsw-alias-label-primary, inherit)',
          font: 'inherit',
          lineHeight: 1.6,
        },
      },
      createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, this.props.title),
      createElement('pre', {
        style: {
          margin: '0 0 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          opacity: 0.9,
        },
      }, `${error.name}: ${error.message}`),
      createElement('div', { style: { fontSize: '12px', opacity: 0.75 } }, this.props.hint),
    )
  }
}

/**
 * Wrap one slot component so a render crash renders a report instead of
 * vanishing. The inner component keeps receiving every prop it got before
 * (owner share + standard seats + the inject face), so this is transparent on
 * the happy path.
 *
 * @param Inner - the registered slot component.
 * @returns a component with the same props contract.
 */
export function withSlotBoundary<P extends object>(Inner: ComponentType<P>): ComponentType<P> {
  const Wrapped = (props: P): ReactElement => {
    const face = props as SlotEntryFace
    const t = typeof face.t === 'function' ? face.t : (key: string): string => key
    return createElement(
      SlotBoundary,
      { title: t('renderFailed'), hint: t('renderFailedHint') },
      createElement(Inner, props),
    )
  }
  const named = Inner as { displayName?: string; name?: string }
  const name = named.displayName ?? named.name ?? 'Slot'
  Wrapped.displayName = `CrossfireBoundary(${name})`
  return Wrapped
}
