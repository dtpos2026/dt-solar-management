/** POS / ERP modules are switched on in Settings (Simple / Customize). A module that is off refuses every call. */
import { MODULES, moduleOn } from '../../shared/modules'
import { AppError, Ctx, getSetting } from './context'

export function isModuleOn(ctx: Ctx, key: string): boolean {
  return moduleOn({ erp_modules: getSetting(ctx.db, 'erp_modules', {}) }, key)
}

export function assertModule(ctx: Ctx, key: string): void {
  if (!isModuleOn(ctx, key)) {
    const label = MODULES.find((m) => m.key === key)?.label ?? key
    throw new AppError(`The ${label} module is switched off. Switch it on in Settings, Simple / Customize.`, 'VALIDATION')
  }
}
