import { rules } from './config'

export interface BlockWindow {
  readonly started: number
  readonly ends: number
}

export class Block {
  private attempt: { window: BlockWindow; readyAt: number } | undefined
  private held = 0n
  private pending = false

  input(pressed: bigint, released: bigint): void {
    this.held = (this.held | pressed) & ~released
    this.pending ||= pressed !== 0n
  }

  takeRequest(): boolean {
    const requested = this.pending || this.held !== 0n
    this.pending = false
    return requested
  }

  reset(): void {
    this.attempt = undefined
    this.pending = false
  }

  press(now: number): boolean {
    if (this.cooldown(now) > 0) return false
    this.attempt = {
      window: { started: now, ends: now + rules.blockWindow },
      readyAt: now + rules.blockCooldown,
    }
    return true
  }

  get window(): BlockWindow | undefined {
    return this.attempt?.window
  }

  cooldown(now: number): number {
    return Math.max(0, (this.attempt?.readyAt ?? 0) - now)
  }

  refresh(now: number): void {
    if (this.attempt) this.attempt.readyAt = now
  }
}
