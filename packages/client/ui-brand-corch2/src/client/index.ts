/** Corch2 occupants for the generic DSH browser-brand slots. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createElement, type ReactNode } from 'react'
import type {
  HeroBrandMarkOwnerProps,
  HeroBrandNameOwnerProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const CORCH_NAME = 'Corch DSH'
const CORCH_HERO_SUFFIX = '//orchestrate your daily work.'
const BEBAS_NEUE_URL = 'https://fonts.loli.net/css2?family=Bebas+Neue:wght@200;400;700&display=swap'

/**
 * Render the Corch sidebar brand name as text.
 * @returns The sidebar text occupant.
 */
export function Corch2BrandName(): ReactNode {
  return createElement('span', {
    style: { fontFamily: 'Bebas Neue, sans-serif', fontSize: '20px', letterSpacing: '2px' },
  }, CORCH_NAME)
}

/**
 * Render the Corch blank-session headline as two independently sized text runs.
 * @param props - The host headline styling.
 * @returns The two-line text occupant.
 */
export function Corch2HeroName(props: HeroBrandNameOwnerProps): ReactNode {
  const { className } = props
  return createElement('span', {
    className,
    style: { fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '4px' },
  },
  createElement('span', { style: { fontSize: '40px', lineHeight: '44px', fontWeight: 700, letterSpacing: '4px' } }, 'Corch'),
  createElement('span', { style: { fontSize: '16px', lineHeight: '24px', fontWeight: 400, letterSpacing: '4px' } }, CORCH_HERO_SUFFIX))
}

/**
 * Suppress the host's default whale while keeping the mark slot occupied by text branding.
 * @param _props - The host mark styling, unused by the empty occupant.
 * @returns No visible mark.
 */
export function Corch2EmptyBrandMark(_props: HeroBrandMarkOwnerProps): ReactNode {
  return null
}

/** Register Corch text and load its font without replacing DSH layout or preview UI. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = BEBAS_NEUE_URL
    link.dataset.dshPlugin = 'ui-brand-corch2'
    document.head.append(link)
    return () => { link.remove() }
  }, 'ui-brand-corch2: Bebas Neue stylesheet')
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.inject('sidebar.brand.mark', () =>
      ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.inject('conversation.hero.brand.name', function* () {
          yield ctx.slots.register({ name: 'sidebar.brand.name' }, Corch2BrandName)
          yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Corch2EmptyBrandMark)
          yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Corch2EmptyBrandMark)
          yield ctx.slots.register({ name: 'conversation.hero.brand.name' }, Corch2HeroName)
        }))))
}

export const inject = ['slots']
